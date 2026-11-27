// cb add / cb bug: the positional words after <project> are the title, or the title then the body (#4447).
// The shell has already grouped a quoted argument into one entry, so an entry holding whitespace was quoted on purpose,
// and bare words never hold any. An empty or blank entry (an empty "$BODY" from a script) counts as absent. So:
//   - no entry holds whitespace (cb add p Fix month parse): the words are one title, joined, as before;
//   - exactly two entries and both hold whitespace (cb add p "Fix month parse" "row 8812 reads 1900"): title, then body;
//     with -b as well, the body is given twice: refused;
//   - any other mix of quoted and bare (cb add p "Fix month" parse, or three or more with one quoted): with -b, all of
//     it is the title, as before; without -b, refused: there is no telling where the title ends.
// A one-word title or body cannot be told apart from bare title words: `cb add p "Title" "Body"` still joins, and -b is
// the way to give a one-word body.
export function titleBody(cmd: 'add' | 'bug', positionals: string[], body: string | undefined): { title: string; body: string | undefined } {
  const right = `cb ${cmd} <project> "<title>" -b "<body>"`;
  const words = positionals.filter((w) => w.trim() !== '');
  const quoted = words.filter((w) => /\s/.test(w)).length;
  if (words.length === 2 && quoted === 2) {
    if (body !== undefined) throw new Error(`the body is given twice (a second argument and -b). Use one: ${right}`);
    return { title: words[0]!, body: words[1] };
  }
  if (quoted === 0 || words.length < 2 || body !== undefined) return { title: words.join(' '), body };
  throw new Error(`${cmd} got ${words.length} arguments after the project and not just bare words or a quoted title and body: there is no telling where the title ends. ` +
    `Give the body with -b (${right}), or quote the whole title as one argument`);
}
