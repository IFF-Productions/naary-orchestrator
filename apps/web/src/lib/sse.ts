/**
 * Minimal incremental SSE (text/event-stream) frame parser, for reading a
 * streamed fetch() body. Native EventSource can't send our bearer/workspace
 * headers or POST a body, so we parse the frames ourselves.
 */

export interface SseFrame {
  /** The frame's `event:` name; "message" when the frame had none (SSE default). */
  event: string;
  /** The frame's `data:` payload; multi-line data lines joined with "\n". */
  data: string;
}

/**
 * Create a stateful parser: feed it decoded chunks as they arrive, get back the
 * frames completed by each chunk. Handles frames split across chunks, multiple
 * frames per chunk, CRLF line endings, and comment lines (": ping" heartbeats —
 * they yield no frame). A frame without any `data:` line is dropped per spec.
 */
export function createSseParser(): { push(chunk: string): SseFrame[] } {
  let buffer = "";
  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk.replace(/\r\n/g, "\n");
      const frames: SseFrame[] = [];
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue; // comment (heartbeat)
          if (line.startsWith("event:")) event = line.slice(6).trimStart();
          else if (line.startsWith("data:"))
            data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length > 0) frames.push({ event, data: data.join("\n") });
      }
      return frames;
    },
  };
}
