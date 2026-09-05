/**
 * Leitura de um corpo `text/event-stream`.
 *
 * Os três streams do app (chat, serviços, agentes) faziam este mesmo laço, cada
 * um com sua cópia. O laço parece bobo mas não é: o `read()` corta onde quiser,
 * então um evento pode chegar partido entre duas leituras — daí o buffer e o
 * `chunks.pop()`, que devolve o pedaço incompleto pra próxima volta.
 *
 * Nada de EventSource: ele não deixa mandar `Authorization`, e toda rota /v1
 * do daemon exige o bearer.
 */
export async function lerEventos(res, onEvent) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const chunks = buf.split("\n\n");
    // o último pedaço é o que ainda não fechou: volta pro buffer
    buf = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(5).trim()));
    }
  }
}
