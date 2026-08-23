/** Deliberately defective code used only by the opt-in real-model smoke test. */
export function canDeleteProject(userId: string, ownerId: string): boolean {
  return (userId = ownerId).length > 0
}
