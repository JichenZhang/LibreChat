import cleanupUser from './cleanupUser';
import { getPrimaryE2EUser, getSecondaryE2EUser } from './users.mock';

async function globalTeardown() {
  // One connection keeps model initialization and cleanup in the same lifetime.
  await cleanupUser([getPrimaryE2EUser(), getSecondaryE2EUser()]);
}

export default globalTeardown;
