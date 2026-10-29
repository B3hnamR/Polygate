import type { IncomingMessage, ServerResponse } from 'node:http';
import * as adapters from '../vendor/protocols/adapters.mjs';
import { GatewayError } from './queue';
export type Protocol = 'chat' | 'responses' | 'anthropic';
adapters.config.agentTools=false;
export function toChat(body: any, protocol: Protocol) {
  if(protocol==='responses' && body.previous_response_id) throw new GatewayError('Send the conversation in input; previous_response_id continuation is not supported by this gateway.',400,'unsupported_parameter');
  const b = protocol==='anthropic' ? adapters.anthropicToChatBody(body,body.model) : protocol==='responses' ? adapters.responsesInputToChatBody(body) : {...body};
  if(!b || !Array.isArray(b.messages) || !b.messages.length) throw new GatewayError('A non-empty messages/input conversation is required',400,'invalid_request_error');
  if(typeof b.model!=='string'||!b.model.trim()) throw new GatewayError('model is required; use auto or a model from /v1/models',400,'invalid_request_error');
  b.stream=true; b.stream_options={include_usage:true}; return b;
}
export function fromChat(chat: any, protocol: Protocol, model: string) { return protocol==='anthropic' ? adapters.chatToAnthropic(chat,model,model) : protocol==='responses' ? adapters.chatToResponses(chat,model,model) : {...chat,model}; }
// Passes bytes through untouched while reporting each SSE `data:` payload. Handles CRLF framing and an unterminated final event.
export function observeSse(onData: (raw: string) => void, onFirstChunk?: () => void, onEveryChunk?: () => void) {
  let scan = ''; let first = false; const decoder = new TextDecoder();
  const consume = (block: string) => { for (const line of block.split('\n')) if (line.startsWith('data:')) onData(line.slice(5).trim()); };
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk); if (!first) { first = true; onFirstChunk?.(); } onEveryChunk?.();
      scan = (scan + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
      let i; while ((i = scan.indexOf('\n\n')) >= 0) { consume(scan.slice(0, i)); scan = scan.slice(i + 2); }
    },
    flush() { scan += decoder.decode(); if (scan.trim()) consume(scan); }
  });
}
export async function collect(response: Response) { return await adapters.collectChatCompletion(response); }
export async function stream(req: IncomingMessage, res: ServerResponse, response: Response, protocol: Protocol, model: string) {
  if(protocol==='anthropic') return await adapters.relayAnthropicStream(req,res,adapters.sseChunks(response),model,model);
  if(protocol==='responses') return await adapters.relayChatAsResponsesStream(req,res,response,model);
  return await adapters.relayStream(req,res,response,model);
}
