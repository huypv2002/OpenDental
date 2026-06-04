import { config } from './config.js';

function chatbotEndpoint(path = '/chat/completions') {
  const baseUrl = String(config.chatbot.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    const error = new Error('CHATBOT_9ROUTER_BASE_URL is not configured on the bridge server.');
    error.status = 500;
    throw error;
  }
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

function chatbotModelsEndpoint() {
  const configured = String(config.chatbot.modelsUrl ?? '').trim();
  if (configured) {
    return configured;
  }

  const baseUrl = String(config.chatbot.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    const error = new Error('CHATBOT_9ROUTER_BASE_URL is not configured on the bridge server.');
    error.status = 500;
    throw error;
  }

  return `${baseUrl.replace(/\/v1$/i, '/api/v1')}/models`;
}

async function readProviderResponse(response) {
  const raw = await response.text();
  const json = raw ? JSON.parse(raw) : {};
  if (!response.ok) {
    const providerMessage = json?.error?.message || json?.error || raw || response.statusText;
    const error = new Error(`9Router returned an error: ${providerMessage}`);
    error.status = response.status;
    error.payload = json;
    throw error;
  }
  return json;
}

export async function proxyChatbotCompletion(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    const error = new Error('Chatbot request body must be a JSON object.');
    error.status = 400;
    throw error;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.chatbot.timeoutMs);

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  if (config.chatbot.apiKey) {
    headers.Authorization = `Bearer ${config.chatbot.apiKey}`;
  }

  try {
    const response = await fetch(chatbotEndpoint('/chat/completions'), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    return await readProviderResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('9Router localhost request timed out.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    if (error instanceof SyntaxError) {
      const parseError = new Error('9Router returned a non-JSON response.');
      parseError.status = 502;
      throw parseError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getChatbotModels() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.chatbot.timeoutMs);

  const headers = {
    Accept: 'application/json'
  };
  if (config.chatbot.apiKey) {
    headers.Authorization = `Bearer ${config.chatbot.apiKey}`;
  }

  try {
    const response = await fetch(chatbotModelsEndpoint(), {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    return await readProviderResponse(response);
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('9Router localhost models request timed out.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    if (error instanceof SyntaxError) {
      const parseError = new Error('9Router returned a non-JSON models response.');
      parseError.status = 502;
      throw parseError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
