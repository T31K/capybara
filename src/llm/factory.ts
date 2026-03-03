import { OpenAIProvider } from "./openai.js";
import { LlamaCppProvider, resolveModelPath } from "./llamacpp.js";
import type { LLMProvider } from "./provider.js";

export interface ModelPreset {
  id: string;
  label: string;
  model: string;
  baseURL?: string;
  apiKeyEnv?: string;
  local?: boolean;
}

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: "qwen3.5-9b",
    label: "Qwen3.5 9B Q4 (Alibaba)",
    model: "llama:./models/Qwen3.5-9B-Q4_K_M.gguf",
    local: true,
  },
  {
    id: "qwen3.5-0.8b",
    label: "Qwen3.5 0.8B Q4 (Alibaba)",
    model: "llama:./models/Qwen3.5-0.8B-Q4_K_M.gguf",
    local: true,
  },
  {
    id: "qwen3.5-4b",
    label: "Qwen3.5 4B Q4 (Alibaba)",
    model: "llama:./models/Qwen3.5-4B-Q4_K_M.gguf",
    local: true,
  },
  {
    id: "qwen3.5-0.6b",
    label: "Qwen3.5 0.6B (Alibaba)",
    model: "qwen3.5:0.6b",
    baseURL: "http://localhost:11434/v1",
    local: true,
  },
  {
    id: "qwen3.5-7b",
    label: "Qwen3.5 7B (Alibaba)",
    model: "qwen3.5:7b",
    baseURL: "http://localhost:11434/v1",
    local: true,
  },
  {
    id: "qwen3.5-14b",
    label: "Qwen3.5 14B (Alibaba)",
    model: "qwen3.5:14b",
    baseURL: "http://localhost:11434/v1",
    local: true,
  },
  {
    id: "qwen3.5-30b",
    label: "Qwen3.5 30B-A3B (Alibaba)",
    model: "qwen3.5:30b-a3b",
    baseURL: "http://localhost:11434/v1",
    local: true,
  },
  {
    id: "llama3.2",
    label: "Llama 3.2 3B (Meta)",
    model: "llama3.2",
    baseURL: "http://localhost:11434/v1",
    local: true,
  },
  {
    id: "qwen2.5-7b",
    label: "Qwen2.5 7B Instruct Q4 (Alibaba)",
    model: "llama:./models/Qwen2.5-7B-Instruct-Q4_K_M.gguf",
    local: true,
  },
  {
    id: "qwen2.5-3b",
    label: "Qwen2.5 3B Instruct Q4 (Alibaba)",
    model: "llama:./models/Qwen2.5-3B-Instruct-Q4_K_M.gguf",
    local: true,
  },
  {
    id: "qwen3-4b",
    label: "Qwen3 4B Q4 (Alibaba)",
    model: "llama:./models/Qwen3-4B-Q4_K_M.gguf",
    local: true,
  },
];

export interface CreateProviderOptions {
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

export function createProvider(opts: CreateProviderOptions = {}): LLMProvider {
  const model = opts.model ?? "llama:./models/Qwen3.5-9B-Q4_K_M.gguf";

  if (model.startsWith("llama:")) {
    const modelPath = resolveModelPath(model.slice("llama:".length));
    const contextLimit = modelPath.includes("0.8B") || modelPath.includes("0.6B") ? 2_048 : 4_096;
    return new LlamaCppProvider(modelPath, contextLimit);
  }

  const baseURL = opts.baseURL ?? resolveBaseURL(model);
  const apiKey = opts.apiKey ?? resolveApiKey(model);
  return new OpenAIProvider(apiKey, model, baseURL);
}

/**
 * Parse a model string that may use prefixed shorthand:
 *   "ollama:qwen3.5:7b"  → { model: "qwen3.5:7b", baseURL: "http://localhost:11434/v1" }
 *   "gpt-4o"             → { model: "gpt-4o", baseURL: undefined }
 */
export function parseModelString(raw: string): { model: string; baseURL?: string } {
  if (raw.startsWith("ollama:")) {
    return {
      model: raw.slice("ollama:".length),
      baseURL: "http://localhost:11434/v1",
    };
  }
  if (raw.startsWith("llama:")) {
    // Keep the full "llama:..." string as-is; createProvider handles it
    return { model: raw };
  }
  // Check against preset IDs
  const preset = MODEL_PRESETS.find((p) => p.id === raw);
  if (preset) {
    return { model: preset.model, baseURL: preset.baseURL };
  }
  return { model: raw };
}

function resolveBaseURL(model: string): string | undefined {
  const preset = MODEL_PRESETS.find((p) => p.model === model || p.id === model);
  return preset?.baseURL;
}

function resolveApiKey(model: string): string | undefined {
  const preset = MODEL_PRESETS.find((p) => p.model === model || p.id === model);
  if (preset?.local) return "ollama"; // Ollama doesn't need a real key
  const envVar = preset?.apiKeyEnv ?? "OPENAI_API_KEY";
  return process.env[envVar];
}
