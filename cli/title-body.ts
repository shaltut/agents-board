// cb add / cb bug: the positional words after <project> are the title, or the title then the body (#4447).
// The shell has already grouped a quoted argument into one entry, so an entry holding whitespace was quoted on purpose,
// and bare words never hold any. So:
//   - no entry holds whitespace (cb add p Fix month parse): the words are one title, joined, as before;
//   - exactly two entries and one holds whitespace (cb add p "Fix month parse" "row 8812 reads 1900"): title, then body;
//   - three or more entries with one holding whitespace: refused, there is no telling where the title ends.
// A body given both ways (-b and a second argument) is refused too. `cb add p "Title" "Body"` with two single words
// still joins: it cannot be told apart from an unquoted two-word title.
export function titleBody(cmd: 'add' | 'bug', words: string[], body: string | undefined): { title: string; body: string | undefined } {
  const right = `cb ${cmd} <project> "<title>" -b "<body>"`;
  if (words.length < 2 || !words.some((w) => /\s/.test(w))) return { title: words.join(' '), body };
  if (words.length > 2) throw new Error(`cb ${cmd} takes one quoted title and at most one body, got ${words.length} arguments after the project. Give the body with -b: ${right}`);
  if (body !== undefined) throw new Error(`the body is given twice (a second argument and -b). Use one: ${right}`);
  return { title: words[0]!, body: words[1] };
}
