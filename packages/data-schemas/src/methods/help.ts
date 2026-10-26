import type { Model } from 'mongoose';
import type { HelpApprovedExport, HelpContext } from 'librechat-data-provider';
import type { IConversation, IMongoFile } from '~/types';

export interface HelpSourceMessage {
  messageId: string;
  parentMessageId?: string;
  text: string;
  isCreatedByUser?: boolean;
  updatedAt?: Date;
  truncated: boolean;
}
export interface HelpChatMethods {
  ensureHelpChat(
    user: string,
    conversationId: string,
    preset: Record<string, unknown>,
  ): Promise<boolean>;
  readHelpChat(
    user: string,
    conversationId: string,
  ): Promise<{
    gardenHelpContext?: HelpContext;
    gardenHelpExports?: HelpApprovedExport[];
  } | null>;
  replaceHelpContext(
    user: string,
    conversationId: string,
    context: HelpContext | null,
  ): Promise<boolean>;
  retainHelpExport(
    user: string,
    conversationId: string,
    value: HelpApprovedExport,
  ): Promise<boolean>;
  releaseHelpExport(user: string, conversationId: string, submissionId: string): Promise<void>;
  readHelpSources(
    user: string,
    conversationId: string,
    ids: string[],
  ): Promise<HelpSourceMessage[]>;
  readHelpAttachment(
    user: string,
    conversationId: string,
    messageId: string,
    fileId: string,
    includeContent?: boolean,
  ): Promise<IMongoFile | null>;
  readHelpBranchIds(user: string, conversationId: string, leaf: string): Promise<string[]>;
}

/** Private context/approval state lives on its native chat and is deleted with that chat. */
export function createHelpChatMethods(mongoose: typeof import('mongoose')): HelpChatMethods {
  const conversations = () => mongoose.models.Conversation as Model<IConversation>;
  return {
    async readHelpAttachment(user, conversationId, messageId, fileId, includeContent = false) {
      if (!(await conversations().exists({ user, conversationId }))) return null;
      if (
        !(await mongoose.models.Message.exists({
          user,
          conversationId,
          messageId,
          'files.file_id': fileId,
        }))
      )
        return null;
      const file = await (mongoose.models.File as Model<IMongoFile>)
        .findOne({
          user: new mongoose.Types.ObjectId(user),
          file_id: fileId,
          $and: [
            { $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }] },
            { $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] },
          ],
        })
        .select('user tenantId file_id filename filepath storageKey source type bytes updatedAt')
        .lean<IMongoFile | null>();
      if (file?.source === 'text' && includeContent) {
        // Do not materialize stored extracts for metadata-only selections or above the package ceiling.
        const [row] = await mongoose.models.File.aggregate<{ text: string }>([
          {
            $match: {
              _id: file._id,
              user: new mongoose.Types.ObjectId(user),
              $expr: { $lte: [{ $strLenBytes: { $ifNull: ['$text', ''] } }, 2097152] },
            },
          },
          { $project: { _id: 0, text: 1 } },
        ]);
        if (!row || typeof row.text !== 'string') return null;
        file.text = row.text;
      }
      return file;
    },
    async readHelpBranchIds(user, conversationId, leaf) {
      const rows = await mongoose.models.Message.find({ user, conversationId })
        .select('messageId parentMessageId')
        .sort({ createdAt: -1 })
        .limit(1000)
        .lean<{ messageId: string; parentMessageId: string }[]>();
      const parents = new Map<string, string>(
        rows.map((row: { messageId: string; parentMessageId: string }) => [
          row.messageId,
          row.parentMessageId,
        ]),
      );
      const ids: string[] = [];
      let id = leaf;
      while (id && parents.has(id) && ids.length < 1000 && !ids.includes(id)) {
        ids.push(id);
        id = parents.get(id) ?? '';
      }
      return ids;
    },
    async ensureHelpChat(user, conversationId, preset) {
      try {
        const inserted = await conversations().updateOne(
          { user, conversationId },
          {
            $setOnInsert: {
              ...preset,
              user,
              conversationId,
              gardenHelp: true,
              title: 'Garden Help',
            },
          },
          { upsert: true },
        );
        return inserted.upsertedCount === 1;
      } catch (error) {
        // Concurrent tabs can race the unique current-user Help chat upsert.
        if (
          (error as { code?: number }).code !== 11000 ||
          !(await conversations().exists({ user, conversationId, gardenHelp: true }))
        )
          throw error;
        return false;
      }
    },
    async readHelpChat(user, conversationId) {
      return conversations()
        .findOne({ user, conversationId, gardenHelp: true })
        .select('gardenHelpContext gardenHelpExports')
        .lean();
    },
    async replaceHelpContext(user, conversationId, context) {
      const result = await conversations().updateOne(
        { user, conversationId, gardenHelp: true },
        context ? { $set: { gardenHelpContext: context } } : { $unset: { gardenHelpContext: 1 } },
      );
      return result.matchedCount === 1;
    },
    async retainHelpExport(user, conversationId, value) {
      const result = await conversations().updateOne(
        {
          user,
          conversationId,
          gardenHelp: true,
          'gardenHelpExports.submission_id': { $ne: value.submission_id },
          // Three unresolved 2 MiB exports plus bounded context stay below Mongo's document limit.
          'gardenHelpExports.2': { $exists: false },
        },
        { $push: { gardenHelpExports: value } },
      );
      if (result.matchedCount === 1) return true;
      const existing = await conversations()
        .findOne({
          user,
          conversationId,
          gardenHelp: true,
          gardenHelpExports: {
            $elemMatch: {
              submission_id: value.submission_id,
              sha256: value.sha256,
              action_id: value.action_id,
              tool_call_id: value.tool_call_id,
            },
          },
        })
        .select('_id')
        .lean();
      return existing != null;
    },
    async releaseHelpExport(user, conversationId, submissionId) {
      await conversations().updateOne(
        { user, conversationId, gardenHelp: true },
        {
          $pull: { gardenHelpExports: { submission_id: submissionId } },
        },
      );
    },
    async readHelpSources(user, conversationId, ids) {
      if (ids.length === 0 || ids.length > 16 || new Set(ids).size !== ids.length) return [];
      const owner = await conversations().exists({ user, conversationId });
      if (!owner) return [];
      // Bound in Mongo, before materializing messages or their tool/attachment payloads.
      const text = {
        $cond: [
          { $ne: [{ $ifNull: ['$text', ''] }, ''] },
          '$text',
          {
            $reduce: {
              input: {
                $filter: {
                  input: { $ifNull: ['$content', []] },
                  as: 'part',
                  cond: { $eq: ['$$part.type', 'text'] },
                },
              },
              initialValue: '',
              in: {
                $concat: [
                  '$$value',
                  {
                    $cond: [
                      { $eq: [{ $type: '$$this.text' }, 'string'] },
                      '$$this.text',
                      { $ifNull: ['$$this.text.value', ''] },
                    ],
                  },
                  '\n',
                ],
              },
            },
          },
        ],
      };
      return mongoose.models.Message.aggregate<HelpSourceMessage>([
        { $match: { user, conversationId, messageId: { $in: ids } } },
        { $limit: 16 },
        {
          $project: {
            _id: 0,
            messageId: 1,
            parentMessageId: 1,
            isCreatedByUser: 1,
            updatedAt: 1,
            text: { $substrCP: [text, 0, 16384] },
            truncated: { $gt: [{ $strLenCP: text }, 16384] },
          },
        },
      ]);
    },
  };
}
