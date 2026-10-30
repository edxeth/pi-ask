/**
 * A session manager whose branch holds a user message and one assistant message with text
 * that calls ask_user with each given id, so the context check lets the form open.
 */
export function sessionWithContext(...toolCallIds: string[]) {
	const branch = [
		{
			type: "message",
			id: "context-user",
			parentId: null,
			timestamp: "2026-10-30T00:00:00.000Z",
			message: { role: "user", content: [{ type: "text", text: "Ask me." }] },
		},
		{
			type: "message",
			id: "context-assistant",
			parentId: "context-user",
			timestamp: "2026-10-30T00:00:01.000Z",
			message: {
				role: "assistant",
				stopReason: "toolUse",
				content: [
					{ type: "text", text: "Here is the context." },
					...toolCallIds.map((id) => ({
						type: "toolCall",
						id,
						name: "ask_user",
						arguments: {},
					})),
				],
			},
		},
	];
	return { getBranch: () => branch };
}
