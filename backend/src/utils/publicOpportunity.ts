// Owner identity on an opportunity (owner_user_id plus the joined owner_name /
// owner_email) is an admin-surface concern: the participant landing page never
// renders it, and GET /api/opportunities[/:id] are optionalAuth so anonymous
// participants reach them by design. Every non-admin response must pass
// through this serializer so the owner's identity never leaves the API.

interface OwnerFields {
  owner_user_id?: unknown;
  owner_name?: unknown;
  owner_email?: unknown;
}

export function toPublicOpportunity<T extends OwnerFields>(
  opportunity: T
): Omit<T, keyof OwnerFields> {
  const { owner_user_id, owner_name, owner_email, ...publicView } = opportunity;
  return publicView;
}
