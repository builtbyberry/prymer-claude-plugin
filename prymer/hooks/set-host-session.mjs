// Prymer PreToolUse hook: inject the coding client session id onto the
// get_context_for_injection call as host_session_id, so Cloud can derive a
// stable episode id. Deterministic and model-independent. Never blocks the
// tool call: any parse failure or missing session id is a silent no-op.
// Pass "codex" as the first argument to emit the Codex envelope.
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  try {
    const payload = JSON.parse(raw);
    const sessionId = payload && payload.session_id;
    if (typeof sessionId !== "string" || sessionId === "") {
      return;
    }
    const toolInput =
      payload && typeof payload.tool_input === "object" && payload.tool_input
        ? payload.tool_input
        : {};
    toolInput.host_session_id = sessionId;
    const out = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: toolInput,
      },
    };
    if (process.argv[2] === "codex") {
      out.hookSpecificOutput.permissionDecision = "allow";
    }
    process.stdout.write(JSON.stringify(out));
  } catch (error) {
    // no-op: never block the tool call
  }
});
