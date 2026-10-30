import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export interface AskContext {
	/** Content block types of the assistant messages since that input, in first-seen order. */
	blockTypes: string[];
	/** Entry id of the last user input before the call; "" when the branch has none. */
	boundaryId: string;
	/** Whether any assistant message since that input has a non-empty text block. */
	hasText: boolean;
}

function isAssistantWithCall(entry: SessionEntry, toolCallId: string): boolean {
	return (
		entry.type === "message" &&
		entry.message.role === "assistant" &&
		entry.message.content.some(
			(part) => part.type === "toolCall" && part.id === toolCallId
		)
	);
}

function isUserInput(entry: SessionEntry): boolean {
	if (entry.type !== "message") {
		return false;
	}
	const { message } = entry;
	if (message.role === "user") {
		return true;
	}
	// An error result (a refusal, an invalid payload, a schema failure) opened no form.
	return (
		message.role === "toolResult" &&
		message.toolName === "ask_user" &&
		!message.isError
	);
}

function assistantParts(entry: SessionEntry) {
	return entry.type === "message" && entry.message.role === "assistant"
		? entry.message.content
		: [];
}

function lastIndexWhere(
	branch: readonly SessionEntry[],
	from: number,
	matches: (entry: SessionEntry) => boolean
): number {
	let index = from;
	while (index >= 0 && !matches(branch[index])) {
		index--;
	}
	return index;
}

/**
 * What the user could read before an ask_user call: the assistant messages since the last
 * user input (a user message, or an ask result that is not an error), up to and including
 * the calling message.
 * Pi saves the calling message before it runs the tool, so it is on the branch.
 */
export function findAskContext(
	branch: readonly SessionEntry[],
	toolCallId: string
): AskContext {
	const callIndex = lastIndexWhere(branch, branch.length - 1, (entry) =>
		isAssistantWithCall(entry, toolCallId)
	);
	if (callIndex < 0) {
		throw new Error(
			`ask_user context check: no assistant message with tool call ${toolCallId} on the active branch`
		);
	}
	const boundaryIndex = lastIndexWhere(branch, callIndex, isUserInput);
	const parts = branch
		.slice(boundaryIndex + 1, callIndex + 1)
		.flatMap((entry) => assistantParts(entry));
	return {
		blockTypes: [...new Set(parts.map((part) => part.type))],
		boundaryId: boundaryIndex >= 0 ? branch[boundaryIndex].id : "",
		hasText: parts.some(
			(part) => part.type === "text" && part.text.trim().length > 0
		),
	};
}
