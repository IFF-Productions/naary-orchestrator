import { ApiProperty } from "@nestjs/swagger";

/** A freshly registered chat endpoint. */
export class RegisteredChatResponse {
  @ApiProperty({ example: "3f9a1c2e-…" }) chatId!: string;
  @ApiProperty({
    example: "/c/3f9a1c2e-…",
    description: "Public path to host the chat (host is deployment-specific).",
  })
  chatPath!: string;
}

/** Management-list view of a registered chat endpoint. */
export class ChatEndpointResponse {
  @ApiProperty({ example: "3f9a1c2e-…" }) id!: string;
  @ApiProperty({ example: "support-chat" }) workflowId!: string;
  @ApiProperty({ format: "date-time", example: "2026-07-10T12:00:00.000Z" })
  createdAt!: Date;
}

/** Public chat definition served to an anonymous browser — NO tenant/workflow identifiers. */
export class ChatDefinitionResponse {
  @ApiProperty({ example: "3f9a1c2e-…" }) chatId!: string;
  @ApiProperty({ required: false, example: "Ask us anything" }) title?: string;
  @ApiProperty({ required: false, example: "We're here to help." })
  description?: string;
  @ApiProperty({ required: false, example: "Type a message…" })
  placeholder?: string;
  @ApiProperty({ required: false, example: "Hi! How can I help?" })
  greeting?: string;
}

/** One RAG source (citation) the chat run used to answer (issue #482) — a privacy-safe subset of a
 *  vectorQuery match: the source collection, a truncated snippet, and the similarity score. */
export class ChatCitationResponse {
  @ApiProperty({ required: false, example: "docs" })
  source?: string;
  @ApiProperty({ example: "Refunds are processed within 5 business days…" })
  snippet!: string;
  @ApiProperty({ required: false, example: 0.87 })
  score?: number;
}

/** The agent's reply to a chat message. */
export class ChatReplyResponse {
  @ApiProperty({ example: "started" }) status!: string;
  @ApiProperty({
    required: false,
    description: "The reply body (from the graph's respondToWebhook node).",
  })
  reply?: unknown;
  @ApiProperty({
    type: [ChatCitationResponse],
    description:
      "RAG sources the run retrieved (issue #482), for the chat UI's 'Sources' list. Empty when the chat graph ran no vectorQuery (retrieval) step.",
  })
  citations!: ChatCitationResponse[];
}

/** Acknowledgement that a chat endpoint was deleted. */
export class ChatDeletedResponse {
  @ApiProperty({ example: true }) deleted!: boolean;
}
