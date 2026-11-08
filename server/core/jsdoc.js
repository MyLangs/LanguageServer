"use strict";

/**
 * Parses JSDoc-style documentation without relying on the MyLang compiler.
 *
 * The analyzer already knows which comment belongs to which declaration. This
 * module only interprets its contents; it never changes the program's tokens,
 * scopes or inferred runtime types.
 *
 * Supported tags include @param, @returns/@return, @type, @deprecated,
 * @example, @throws/@exception and @see. Other tags are preserved for Hover.
 */

/** Remove the comment delimiters and the conventional `*` margin. */
function cleanComment(source) {
  return source
    .replace(/^\s*\/\*\*?/, "")
    .replace(/\*\/\s*$/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[ \t]*\*(?:[ \t]?)/, "").replace(/[ \t]+$/, ""))
    .join("\n")
    .trim();
}

/**
 * Read an optional `{type}` prefix, including balanced object or generic-ish
 * expressions such as `{{ id: number }}`. Malformed types are left as text.
 */
function readType(value) {
  const source = value.trimStart();
  if (!source.startsWith("{")) return { type: "", rest: source };

  let depth = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        return {
          type: source.slice(1, i).trim(),
          rest: source.slice(i + 1).trim(),
        };
      }
    }
  }

  return { type: "", rest: source };
}

/** Parse the name, type, optional default and description of an @param tag. */
function parseParam(value) {
  const { type, rest } = readType(value);
  const match = /^(\[[^\]]+\]|\.\.\.[\w$]+|[\w$]+\??)(?:\s*[-–:]\s*|\s+)?([\s\S]*)$/.exec(rest);
  if (!match) return { name: "", type, description: rest };

  let name = match[1];
  let optional = false;
  let restParam = false;
  let defaultValue;

  if (name.startsWith("[") && name.endsWith("]")) {
    optional = true;
    name = name.slice(1, -1);
    const equals = name.indexOf("=");
    if (equals >= 0) {
      defaultValue = name.slice(equals + 1);
      name = name.slice(0, equals);
    }
  }
  if (name.startsWith("...")) {
    restParam = true;
    name = name.slice(3);
  }
  if (name.endsWith("?")) {
    optional = true;
    name = name.slice(0, -1);
  }

  return {
    name,
    type,
    description: match[2].trim(),
    optional,
    rest: restParam,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

/**
 * @typedef {{name: string, type: string, description: string, optional?: boolean,
 *   rest?: boolean, default?: string}} DocParameter
 * @typedef {{description: string, params: DocParameter[], returns: {type: string,
 *   description: string}|null, type: string, deprecated: string|null,
 *   examples: string[], throws: {type: string, description: string}[],
 *   see: string[], tags: {name: string, value: string}[]}} JSDoc
 */

/**
 * Interpret already-cleaned comment text (also accepts a raw `/** ... *\/`).
 * Continuation lines belong to the preceding tag, not to the description.
 *
 * @param {string} source
 * @returns {JSDoc}
 */
function parseJSDoc(source = "") {
  const text = /^\s*\/\*/.test(source) ? cleanComment(source) : String(source).trim();
  const sections = [{ name: "description", lines: [] }];
  let current = sections[0];

  for (const line of text.split(/\r?\n/)) {
    const tag = /^\s*@([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(line);
    if (tag) {
      current = { name: tag[1].toLowerCase(), lines: [tag[2] || ""] };
      sections.push(current);
    } else {
      current.lines.push(line);
    }
  }

  const result = {
    description: sections[0].lines.join("\n").trim(),
    params: [],
    returns: null,
    type: "",
    deprecated: null,
    examples: [],
    throws: [],
    see: [],
    tags: [],
  };

  for (const section of sections.slice(1)) {
    const value = section.lines.join("\n").trim();
    switch (section.name) {
      case "param":
      case "arg":
      case "argument":
        result.params.push(parseParam(value));
        break;
      case "return":
      case "returns": {
        const parsed = readType(value);
        result.returns = { type: parsed.type, description: parsed.rest };
        break;
      }
      case "type":
        result.type = readType(value).type || value;
        break;
      case "deprecated":
        result.deprecated = value || "This symbol is deprecated.";
        break;
      case "example":
        result.examples.push(value);
        break;
      case "throws":
      case "throw":
      case "exception": {
        const parsed = readType(value);
        result.throws.push({ type: parsed.type, description: parsed.rest });
        break;
      }
      case "see":
        result.see.push(value);
        break;
      default:
        result.tags.push({ name: section.name, value });
    }
  }

  return result;
}

/** Return the JSDoc declaration for a parameter, if present. */
function parameterDoc(documentation, name) {
  return documentation?.params.find((param) => param.name === name) || null;
}

/** Render parsed JSDoc as Markdown suitable for LSP Hover and completion items. */
function renderJSDoc(documentation) {
  if (!documentation) return "";
  const parts = [];

  if (documentation.description) parts.push(documentation.description);
  if (documentation.deprecated !== null) {
    parts.push(`**Deprecated:** ${documentation.deprecated}`);
  }
  if (documentation.type) parts.push(`**Type:** \`${documentation.type}\``);
  if (documentation.params.length) {
    const rows = documentation.params.map((param) => {
      const name = param.name || "?";
      const type = param.type ? ` \`{${param.type}}\`` : "";
      const suffix = param.optional ? " (optional)" : "";
      const defaultValue = param.default === undefined ? "" : `, default: \`${param.default}\``;
      const description = param.description ? ` — ${param.description}` : "";
      return `- \`${param.rest ? "..." : ""}${name}\`${type}${suffix}${defaultValue}${description}`;
    });
    parts.push(`**Parameters**\n${rows.join("\n")}`);
  }
  if (documentation.returns) {
    const { type, description } = documentation.returns;
    parts.push(
      `**Returns:**${type ? ` \`${type}\`` : ""}${description ? ` — ${description}` : ""}`,
    );
  }
  if (documentation.throws.length) {
    parts.push(
      "**Throws**\n" +
        documentation.throws
          .map(
            ({ type, description }) =>
              `- ${type ? `\`${type}\`` : "Error"}${description ? ` — ${description}` : ""}`,
          )
          .join("\n"),
    );
  }
  for (const example of documentation.examples) {
    parts.push(`**Example**\n\`\`\`mylang\n${example}\n\`\`\``);
  }
  if (documentation.see.length) {
    parts.push(`**See also:** ${documentation.see.join(", ")}`);
  }
  for (const tag of documentation.tags) {
    parts.push(`**@${tag.name}**${tag.value ? ` ${tag.value}` : ""}`);
  }

  return parts.join("\n\n");
}

module.exports = { cleanComment, parseJSDoc, parameterDoc, renderJSDoc };
