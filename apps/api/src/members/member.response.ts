import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/** One Team-screen row: an ACTIVE member (a real Membership) or a PENDING invitation. */
export class MemberResponse {
  @ApiProperty({
    example: "firebase-uid-or-invitation-id",
    description:
      "Firebase uid for active rows (the PATCH/DELETE key); invitation id for invited rows.",
  })
  id!: string;
  @ApiPropertyOptional({
    example: "u_7c1de4",
    description: "Firebase uid — present on active rows only.",
  })
  userId?: string;
  @ApiProperty({ example: "teammate@acme.com", format: "email" })
  email!: string;
  @ApiProperty({
    example: "member",
    enum: ["owner", "admin", "member"],
  })
  role!: string;
  @ApiProperty({
    enum: ["active", "invited"],
    description:
      "'active' = a real membership; 'invited' = pending until the invitee signs in with " +
      "a verified matching email.",
  })
  status!: "active" | "invited";
  @ApiProperty({ format: "date-time" }) createdAt!: string;
  @ApiPropertyOptional({
    type: "string",
    format: "date-time",
    nullable: true,
    description:
      "Last authenticated request in this workspace (active rows only). null = not seen " +
      "since tracking began; absent on invited rows.",
  })
  lastActiveAt?: string | null;
}

/** One paused run the removed member was a listed approver on (#1053). */
export class StrandedApprovalRunResponse {
  @ApiProperty({
    example: "run_2f9c1a",
    description: "Temporal workflowId — the run's id in /app/runs/:id.",
  })
  workflowId!: string;
  @ApiProperty({
    type: "string",
    nullable: true,
    example: "invoice-approval",
    description:
      "The run's workflow key; null for runs predating key tracking.",
  })
  workflowKey!: string | null;
  @ApiProperty({
    example: "approve-1",
    description: "The paused humanApproval node.",
  })
  nodeId!: string;
  @ApiProperty({
    description:
      "No listed approver identity is left on this gate — only a workspace owner/admin " +
      "(or the signed approval link) can decide it now.",
  })
  needsOwnerOrAdmin!: boolean;
}

/**
 * What a member removal left behind (#1053). A humanApproval gate freezes its approver list
 * at pause time, so removing someone can leave a paused run nobody can decide — reported
 * here rather than auto-decided, because a run must never report a decision no human made.
 */
export class StrandedApprovalsResponse {
  @ApiProperty({
    example: 3,
    description:
      "Paused runs whose frozen approver snapshot named the removed member.",
  })
  total!: number;
  @ApiProperty({
    example: 1,
    description:
      "Of those, the ones with NO approver identity left — the number to lead with. A " +
      "group-routed gate is unaffected while anyone else is in the group.",
  })
  needsOwnerOrAdmin!: number;
  @ApiProperty({
    description:
      "The counts are a LOWER BOUND: the scan was truncated, ran out of its time budget, " +
      "or failed. true with zero counts means 'could not check', NOT 'none'.",
  })
  partial!: boolean;
  @ApiProperty({
    type: [StrandedApprovalRunResponse],
    description: "Up to 20 of them, the ones needing an owner/admin first.",
  })
  runs!: StrandedApprovalRunResponse[];
}

/** `DELETE /tenants/:id/members/:userId`. 200 (not 204) so the removal can report what it
 *  affected — the removal itself always commits before this is assembled. */
export class RemoveMemberResponse {
  @ApiProperty({
    description:
      "false when the uid held no membership here — the delete was a no-op.",
  })
  removed!: boolean;
  @ApiProperty({ type: StrandedApprovalsResponse })
  strandedApprovals!: StrandedApprovalsResponse;
}
