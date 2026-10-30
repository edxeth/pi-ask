/** Fixed behavior set from spec #1. Each case starts in a new RPC session. */
export const cases = [
	{
		id: "naming",
		prompt:
			"We need a name for a new local note-taking tool. Before you choose a name, ask me to choose between two distinct naming directions. Do not decide for me.",
	},
	{
		id: "scope",
		prompt:
			"Plan the first release of a local note-taking tool. Offline-only and cloud sync are both valid scope directions. Ask me which scope I prefer before planning.",
	},
	{
		id: "tone",
		prompt:
			"Design the UI tone for a local note-taking tool. Show two distinct visual tone mockups using a preview-type ask_user question so I can compare them before you choose.",
	},
	{
		id: "note",
		prompt:
			"Ask me which of two onboarding directions to take for a local note-taking tool. I will attach a note to my answer. Respond to my note before moving forward.",
	},
	{
		id: "narrowing",
		prompt:
			"Plan a note-taking tool. Ask first whether this is for solo use or a team. My answer will narrow the path. After I answer, ask the next two related decisions together in one ask_user call, not as plain-text choices. Stop after I answer the second ask.",
	},
	{
		id: "subagent",
		kind: "print",
		prompt:
			"You are a background subagent. The owner must choose whether a local note-taking app stores notes only on this device or syncs them to a cloud service. The owner has not chosen. Ask the owner for this decision before proposing the release plan. If you cannot ask, do not choose for them; state what blocks the plan. Summarize what you accomplished and stop.",
	},
	{
		id: "interview",
		prompt:
			"Interview me about a local note-taking app, then write a short PLAN: with the agreed decisions. Work in rounds: first ask whether this is for solo use or a team. After my answer, bundle two independent decisions about that branch into one ask_user call. After those answers, ask one more decision that depends on them. Do not repeat settled questions. Stop asking after the last answer and write PLAN: with the choices I made.",
	},
	{
		id: "config",
		prompt:
			"Change the ask_user keymap for submit. Before changing any pi-ask settings or keys, read the pi-ask configuration documentation. Do not edit files in this exercise; report the documented setting you would change.",
	},
	{
		// The user has not read the file, so the fact must reach them as message text before the ask.
		id: "context",
		prompt:
			"Read docs/adr/0003-base-model-gates-model-facing-text.md. Then ask me whether the base model named there should change. Do not decide for me.",
		factPattern: "deepseek",
	},
	{
		id: "typed-question",
		prompt:
			"Help me choose how a local note-taking app stores its notes. Ask me to choose between two storage designs before you plan.",
		firstAnswer:
			"I don't understand these options. What is the difference between them?",
	},
	{
		id: "explain-only",
		prompt:
			"Plan the sync feature of a local note-taking app. Ask me which conflict strategy to use before you plan.",
		firstAnswer:
			"Explain these options to me first. Do not use the form again; I will reply in chat.",
	},
];
