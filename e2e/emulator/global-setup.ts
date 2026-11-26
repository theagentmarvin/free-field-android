import { seed } from "./rest";

/** Runs once before the specs, after scripts/e2e-emulator.sh started the emulators. */
export default async function globalSetup(): Promise<void> {
  await seed();
  console.log("emulator seed: 2 users, 3 projects, memberships written");
}
