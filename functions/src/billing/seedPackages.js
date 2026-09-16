/**
 * ⚠️  DEPRECATED — DO NOT RUN THIS SCRIPT.
 *
 * Packages are now managed exclusively through the Admin Panel UI.
 * The Admin Panel uses the `upsertPackage` callable function which creates
 * packages with auto-generated Firestore IDs.
 *
 * This seed script used fixed document IDs which conflicted with
 * admin-created packages, causing duplicates on the client dashboard.
 *
 * If you need to create packages, use the Admin Panel instead:
 *   https://authenticator-15fb7.web.app/admin/packages
 */

async function seedPackages() {
  console.warn(
    "[seedPackages] DEPRECATED — use the Admin Panel to manage packages.",
  );
  console.warn("[seedPackages] No action taken.");
}

if (require.main === module) {
  seedPackages().then(() => process.exit(0));
}

module.exports = { seedPackages };
