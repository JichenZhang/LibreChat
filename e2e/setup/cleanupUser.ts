import type { Model, Mongoose } from 'mongoose';
import { applyRuntimeEnv } from './runtimeEnv';

type TUser = { email: string; password: string };

export default async function cleanupUser(user: TUser | TUser[]) {
  applyRuntimeEnv();
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { Mongoose: MongooseInstance } = require('mongoose');
  const { createModels, createMethods } = require('@librechat/data-schemas');
  /* eslint-enable @typescript-eslint/no-require-imports */

  if (!process.env.MONGO_URI) throw new Error('E2E cleanup requires MONGO_URI');

  const users = Array.isArray(user) ? user : [user];
  const failures: unknown[] = [];
  // A cleanup owns its connection and models. Reopening the backend singleton
  // starts model.init() against its previously closed client before reconnecting.
  const db: Mongoose = new MongooseInstance();
  try {
    console.log('🤖: global teardown has been started');
    await db.connect(process.env.MONGO_URI, { bufferCommands: false });
    console.log('🤖:  ✅  Connected to Database');

    const { User, Balance, Transaction, AclEntry, Token, Group } = createModels(db);
    const { findUser, deleteConvos, deleteMessages, deleteAllUserSessions } = createMethods(db);

    for (const { email } of users) {
      const foundUser = await findUser({ email });
      if (!foundUser) {
        console.log('🤖:  ⚠️  User not found in Database');
        continue;
      }

      const userId = foundUser._id;
      console.log('🤖:  ✅  Found user in Database');

      // Delete all conversations & associated messages
      const { deletedCount, messages } = await deleteConvos(userId, {}).catch((error) => {
        if (error instanceof Error && error.message.includes('Conversation not found')) {
          console.log('🤖:  ⚠️  No conversations found for user');
          return { deletedCount: 0, messages: { deletedCount: 0 } };
        }

        throw error;
      });

      if (messages.deletedCount > 0 || deletedCount > 0) {
        console.log(`🤖:  ✅  Deleted ${deletedCount} convos & ${messages.deletedCount} messages`);
      }

      // Ensure all user messages are deleted
      const { deletedCount: deletedMessages } = await deleteMessages({ user: userId });
      if (deletedMessages > 0) {
        console.log(`🤖:  ✅  Deleted ${deletedMessages} remaining message(s)`);
      }

      // Delete all user sessions
      await deleteAllUserSessions(userId.toString());

      // Delete user, balance, transactions, tokens, ACL entries, and remove from groups
      await Balance.deleteMany({ user: userId });
      await Transaction.deleteMany({ user: userId });
      await Token.deleteMany({ userId: userId });
      await AclEntry.deleteMany({ principalId: userId });
      const userIdStr = userId.toString();
      await Group.updateMany({ memberIds: userIdStr }, { $pullAll: { memberIds: [userIdStr] } });
      await User.deleteMany({ _id: userId });

      console.log('🤖:  ✅  Deleted user from Database');
    }
  } catch (error) {
    failures.push(error);
  } finally {
    if (db) {
      try {
        // Model registration starts real index initialization in the background.
        const initialized = await Promise.allSettled(
          Object.values(db.connection.models as Record<string, Model<object>>).map((model) =>
            model.init(),
          ),
        );
        for (const result of initialized) {
          if (result.status === 'rejected') failures.push(result.reason);
        }
      } finally {
        await db.connection.close().catch((error: unknown) => failures.push(error));
      }
    }
  }
  if (failures.length) throw new AggregateError(failures, 'E2E cleanup failed');
}
