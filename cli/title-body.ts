// cb add / cb bug: the positional words after <project> are the title, or the title then the body (#4447).
// The shell has already grouped a quoted argument into one entry, so an entry holding whitespace was quoted on purpose,
// and bare words never hold any. So:
//   - no entry holds whitespace (cb add p Fix month parse): the words are one title, joined, as before;
//   - exactly two entries and both hold whitespace (cb add p "Fix month parse" "row 8812 reads 1900"): title, then body;
//   - any other mix of quoted and bare (cb add p "Fix month" parse, or three or more with one quoted): refused,
//     there is no telling where the title ends.
// A body given both ways (-b and a second argument) is refused too. A one-word title or body cannot be told apart
// from bare title words: `cb add p "Title" "Body"` still joins, and -b is the way to give a one-word body.
export function titleBody(cmd: 'add' | 'bug', words: string[], body: string | undefined): { title: string; body: string | undefined } {
  const right = `cb ${cmd} <project> "<title>" -b "<body>"`;
  const quoted = words.filter((w) => /\s/.test(w)).length;
  if (words.length < 2 || quoted === 0) return { title: words.join(' '), body };
  if (words.length > 2 || quoted < 2) {
    throw new Error(`${cmd} got ${words.length} arguments after the project and not just bare words or a quoted title and body: there is no telling where the title ends. ` +
      `Give the body with -b (${right}), or quote the whole title as one argument`);
  }
  if (body !== undefined) throw new Error(`the body is given twice (a second argument and -b). Use one: ${right}`);
  return { title: words[0]!, body: words[1] };
}
