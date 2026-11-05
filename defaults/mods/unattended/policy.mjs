// Decisions are made from protocol requests, never from terminal output.
export const CONTINUE = "Yes, proceed with the existing task. Use my configured devices, tools and preferences; choose reasonable defaults and continue through completion. My explicit restrictions and later instructions still take precedence. Do not ask again merely for permission already granted. If information is unavailable, do the independent work and report the concrete blocker.";

export function instructions(exceptions = []) {
  return `I have enabled Herdr unattended mode for this task. I pre-authorize the operations needed to complete it, including using my configured phone and remote computer through my existing tools. Routine permission and continuation questions default to Yes. Follow my existing device and browser routing preferences. Make implementation choices yourself, verify the result, and persist until the requested work is complete. This standing authorization does not override my explicit task restrictions, later instructions, or a user takeover of a device. Do not invent missing credentials or pretend an unavailable device is connected.${exceptions.length ? `\nThese request keywords are exceptions to automatic approval and must be left for me: ${exceptions.join(", ")}.` : ""}`;
}

const affirmative = /^(?:(?:yes|accept|allow|approve|proceed|continue|confirm|ok(?:ay)?|go ahead)\b|是(?:的)?(?:[，。：（(、\s]|$)|同意|允许|批准|继续|确认)/i;
const recommended = /\b(?:recommended|suggested)\b|推荐|建议/i;
const secret = /password|passphrase|verification.code|one.time.code|api.key|access.token|密码|验证码|密钥/i;

export function exceptionFor(request, exceptions = []) {
  const text = (typeof request === "string" ? request : JSON.stringify(request)).toLocaleLowerCase();
  return exceptions.find(rule => rule.trim() && text.includes(rule.trim().toLocaleLowerCase())) ?? null;
}

export function answerQuestion(q) {
  if (q.isSecret || (!(q.options?.length) && /(?:enter|provide|type|what is|输入|提供|填写)/i.test(q.question ?? "") && secret.test(q.question ?? ""))) return null;
  const options = (q.options ?? []).map(o => typeof o === "string" ? { label: o } : o);
  const yes = options.find(o => affirmative.test(o.label));
  const preferred = options.find(o => recommended.test(o.label));
  // A supplied choice is authoritative; do not manufacture an option label.
  if (yes || preferred || options.length) return (yes ?? preferred ?? options[0]).label;
  return CONTINUE;
}

export function answerQuestions(questions, engine) {
  if (!Array.isArray(questions) || !questions.length) return null;
  const answers = Object.create(null);
  for (const q of questions) {
    const value = answerQuestion(q);
    const key = engine === "claude" ? q.question : q.id;
    if (value === null || typeof key !== "string" || !key) return null;
    answers[key] = engine === "claude" ? value : { answers: [value] };
  }
  return answers;
}

// MCP forms may ask for real data. Only fill values the form actually supplies,
// or affirmative booleans/choices; unknown required values stay unanswered.
export function answerForm(schema) {
  if (!schema || schema.type !== "object" || !schema.properties) return null;
  const result = Object.create(null);
  for (const [key, field] of Object.entries(schema.properties)) {
    if (secret.test(`${key} ${field.title ?? ""}`)) return null;
    let value;
    if (field.type === "boolean") value = true;
    else if (field.default !== undefined && field.default !== null) value = field.default;
    else if (field.enum) value = field.enum.find(v => typeof v === "string" && affirmative.test(v));
    else if (field.oneOf) value = field.oneOf.find(o => affirmative.test(o.title ?? String(o.const)))?.const;
    if (value === undefined) {
      if ((schema.required ?? []).includes(key)) return null;
      continue;
    }
    if (field.enum && !field.enum.includes(value)) return null;
    if (field.type === "string" && (typeof value !== "string" || value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? Infinity))) return null;
    if (["number", "integer"].includes(field.type) && (typeof value !== "number" || value < (field.minimum ?? -Infinity) || value > (field.maximum ?? Infinity) || (field.type === "integer" && !Number.isInteger(value)))) return null;
    result[key] = value;
  }
  return result;
}

export function codexDecision(method, params) {
  if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(method)) {
    if (params.availableDecisions && !params.availableDecisions.includes("accept")) return null;
    return { decision: "accept" };
  }
  if (method === "item/permissions/requestApproval") return { permissions: params.permissions, scope: "turn" };
  if (["item/tool/requestUserInput", "tool/requestUserInput"].includes(method)) {
    const answers = answerQuestions(params.questions, "codex");
    return answers ? { answers } : null;
  }
  if (method === "mcpServer/elicitation/request" && ["form", "openai/form"].includes(params.mode)) {
    const content = answerForm(params.requestedSchema);
    return content ? { action: "accept", content } : null;
  }
  return null;
}

export function claudeDecision(request) {
  if (request.subtype === "can_use_tool") {
    if (request.tool_name === "AskUserQuestion") {
      const answers = answerQuestions(request.input?.questions, "claude");
      return answers ? { behavior: "allow", updatedInput: { ...request.input, answers } } : null;
    }
    return { behavior: "allow", updatedInput: request.input ?? {} };
  }
  if (request.subtype === "elicitation" && (request.mode ?? "form") === "form") {
    const content = answerForm(request.requested_schema);
    return content ? { action: "accept", content } : null;
  }
  return null;
}

export function asksToContinue(text) {
  // Only assistant final messages enter this function. Tool output never does.
  const tail = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
    .replace(/^\s*>.*$/gm, "").replace(/"[^"\n]*"/g, "").trim().slice(-1800);
  return /(?:would you like me to|shall I|should I|may I|can I|do you want me to)[^\n]{0,500}\?/i.test(tail)
    || /(?:if you (?:want|would like),? I can)[^\n]{0,500}[.!?]?\s*$/i.test(tail)
    || /(?:please confirm(?:[^\n]{0,120}\b(?:proceed|continue|permission|approval)\b)?|(?:reply|respond|type)[^\n]{0,120}\b(?:proceed|continue|confirm|approve)\b)[^\n]{0,120}[.!:]?\s*$/i.test(tail)
    || /(?:要不要|能否|是否(?:需要|可以)?|需要我|要我|可以(?:让我|继续)?)[^\n]{0,250}[？?]/.test(tail)
    || /如果你(?:愿意|需要|同意)[，,]?[^\n]{0,250}(?:我可以|我会)/.test(tail)
    || /(?:请(?:你)?确认|等待你的(?:确认|同意|授权)|等你(?:确认|同意|授权)|(?:请)?回复[^\n]{0,80}(?:继续|同意|确认|开始))[^\n]{0,120}[。！：]?\s*$/.test(tail);
}
