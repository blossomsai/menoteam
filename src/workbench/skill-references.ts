export function referencedPaths(content: string): string[] {
    const found = new Set<string>();
    const add = (raw: string) => {
        let value = raw.trim();
        if (value.startsWith('<') && value.includes('>')) value = value.slice(1, value.indexOf('>'));
        else value = value.split(/\s+/u, 1)[0]!;
        value = value.split(/[?#]/u, 1)[0]!.replace(/[.,;:!?]+$/u, '');
        if (!value || /^(?:[a-z][a-z0-9+.-]*:|#)/iu.test(value)) return;
        try { value = decodeURIComponent(value); } catch { throw Object.assign(new Error('SKILL.md contains an invalid local reference'), { statusCode: 400 }); }
        found.add(value);
    };
    for (const match of content.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^)]+)\)/gu)) add(match[1]!);
    for (const match of content.matchAll(/^\s{0,3}\[[^\]]+\]:\s*(<[^>]+>|\S+)/gmu)) add(match[1]!);
    // Recognize file paths, regardless of extension. A bare basename needs an
    // explicit file reference (Markdown or a file directive), so quoted code
    // such as versions, abbreviations and object properties isn't a dependency.
    for (const match of content.matchAll(/(^|[\s(`"'])([^\s()`"'<>\[\]{}]+)/gmu)) {
        const value = match[2]!.split(/[?#]/u, 1)[0]!.replace(/[.,;:!?]+$/u, '');
        if (/^(?:[a-z][a-z0-9+.-]*:|#)/iu.test(value)) continue;
        const quoted = /[`"']/u.test(match[1]!);
        const before = content.slice(content.lastIndexOf('\n', match.index!) + 1, match.index! + match[1]!.length).replace(/[`"']$/u, '');
        const fileDirective = /\b(?:read|open|run|include|load|execute|source)\s+$/iu.test(before);
        // Implicit extensionless operands need a terminal command position.
        // Slash prose followed by more words isn't file evidence; ambiguous
        // references can use quotation or Markdown. No interpreter parsing occurs.
        const after = content.slice(match.index! + match[0].length);
        const commandOperand = /\b(?:run|execute|source)[ \t]+(?:[^\s;]+(?<![.!?])[ \t]+)*$/iu.test(before)
            && (/[.;!?]$/u.test(match[2]!) || /^[ \t]*(?:$|[;\n])/u.test(after));
        const filename = /\.[a-z][^/.]*$/iu.test(value);
        const pathWithSuffix = /\/[^/]+\.[^/.]+$/u.test(value);
        if ((value.includes('/') && (pathWithSuffix || quoted || fileDirective || commandOperand || /^(?:\.{1,2}\/|\/)/u.test(value))) || (fileDirective && filename)) add(value);
    }
    return [...found];
}
