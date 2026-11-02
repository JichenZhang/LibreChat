import mongoose from 'mongoose';
import { randomUUID } from 'node:crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { HelpTurnContext } from 'librechat-data-provider';
import { createHelpChatMethods } from './help';
import { createModels } from '../models';

let server: MongoMemoryServer;
const help = createHelpChatMethods(mongoose);
beforeAll(async () => {
  server = await MongoMemoryServer.create();
  Object.assign(mongoose.models, createModels(mongoose));
  await mongoose.connect(server.getUri());
  await mongoose.models.Message.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});
test('message-bound context survives native metadata-only re-save, cannot be replaced, and is owner scoped', async () => {
  const user = new mongoose.Types.ObjectId().toHexString();
  const conversationId = randomUUID();
  await help.ensureHelpChat(user, conversationId, { endpoint: 'custom' });
  const messageId = randomUUID();
  const context: HelpTurnContext = {
    context: {
      captured_at: new Date().toISOString(),
      label: 'Settings · account',
      evidence: [],
      selection: { kind: 'settings', tab: 'account' },
    },
    status: 'captured',
  };
  await mongoose.models.Message.create({
    user,
    conversationId,
    messageId,
    text: 'Synthetic question',
    isCreatedByUser: true,
  });
  await help.bindHelpTurnContext(user, conversationId, messageId, context);
  const previous = await mongoose.models.Message.findOne({ user, messageId }).lean<{
    updatedAt: Date;
  }>();
  await mongoose.models.Message.updateOne(
    { user, messageId },
    { $set: { text: 'Synthetic question' } },
  );
  const updated = await mongoose.models.Message.findOne({ user, messageId }).lean<{
    updatedAt: Date;
  }>();
  expect(updated!.updatedAt.getTime()).toBeGreaterThanOrEqual(previous!.updatedAt.getTime());
  expect(await help.readHelpTurnContext(user, conversationId, [messageId])).toEqual(context);
  expect(
    await help.bindHelpTurnContext(user, conversationId, messageId, {
      context: null,
      status: 'none',
    }),
  ).toEqual(context);
  expect(await help.readHelpTurnContext('other-user', conversationId, [messageId])).toBeNull();
  await expect(
    help.bindHelpTurnContext('other-user', conversationId, messageId, context),
  ).rejects.toThrow('UNAUTHENTICATED');
});
