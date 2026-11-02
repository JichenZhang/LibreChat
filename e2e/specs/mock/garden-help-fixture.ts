import { request } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import mongoose from 'mongoose';
const password = 'GardenHelpLocalFixture123!';
export async function setupHelpFixture(
  baseURL?: string,
  email = 'garden-help-u2@example.invalid',
  subject = 'u2-alice',
) {
  const directory = process.env.E2E_HELP_FIXTURE;
  if (
    !directory ||
    readFileSync(resolve(directory, 'owner.txt'), 'utf8').trim() !==
      'H1_GARDEN_HELP_ISOLATED;run=135b7bbee790;port=25479'
  )
    throw new Error('Requires the explicitly owned U2 local fixture');
  const { MONGO_URI } = JSON.parse(readFileSync(resolve(directory, 'native-mongo.json'), 'utf8'));
  const uri = new URL(MONGO_URI);
  if (uri.hostname !== '127.0.0.1' || uri.pathname !== '/GardenHelpU2Fixture')
    throw new Error('Refusing non-fixture database');
  const db = await mongoose.createConnection(MONGO_URI).asPromise();
  const context = await request.newContext({ baseURL });
  // The first native account is a local bootstrap; the employee remains a native USER.
  for (const [userEmail, name] of [
    ['garden-help-bootstrap@example.invalid', 'Local Bootstrap'],
    [email, 'U2 Employee'],
  ]) {
    // Replaying this owned fixture must reuse its accounts, rather than
    // exhausting native registration limits before any journey can run.
    if (await db.collection('users').findOne({ email: userEmail })) continue;
    const response = await context.post('/api/auth/register', {
      data: { email: userEmail, name, password, confirm_password: password },
    });
    if (![200, 201, 400, 409, 422].includes(response.status()))
      throw new Error(`Local registration failed (${response.status()})`);
  }
  await context.dispose();
  const result = await db
    .collection('users')
    .updateOne({ email }, { $set: { openidId: subject, emailVerified: true } });
  if (result.matchedCount !== 1) throw new Error('Missing isolated employee');
  await db.close();
}
