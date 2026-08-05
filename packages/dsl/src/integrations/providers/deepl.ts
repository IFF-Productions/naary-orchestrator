// ── DeepL (base = the connection's API host: api-free.deepl.com for a Free key,
//    api.deepl.com for Pro — a Free key only authenticates on the free host). Auth is
//    DeepL's own `Authorization: DeepL-Auth-Key <key>`, i.e. the custom-header form. ─────
import type { IntegrationProvider } from "../types";

export const DEEPL: IntegrationProvider = {
  key: "deepl",
  label: "DeepL",
  baseUrlFromConnection: true,
  serverUrlExample: "https://api-free.deepl.com or https://api.deepl.com",
  authScheme: { header: "Authorization", prefix: "DeepL-Auth-Key " },
  description:
    "Translate text with DeepL — translate, check quota usage, list supported languages.",
  auth: "A custom connection whose Server URL is your DeepL API host (https://api-free.deepl.com for a Free key, https://api.deepl.com for Pro) and whose token is the DeepL auth key, sent as `Authorization: DeepL-Auth-Key <key>` — DeepL's own scheme, not a Bearer.",
  actions: [
    {
      key: "translate_text",
      label: "Translate text",
      description:
        "Translate one or more strings into a target language (not a mutation — safe to retry).",
      method: "POST",
      pathTemplate: "/v2/translate",
      write: false,
      fields: [
        {
          key: "text",
          label: "Text",
          in: "body",
          required: true,
          type: "json",
          hint: '["Hello world!"] — an array of strings',
        },
        {
          key: "target_lang",
          label: "Target language",
          in: "body",
          required: true,
          hint: "e.g. DE, FR, EN-GB (uppercase)",
        },
        {
          key: "source_lang",
          label: "Source language",
          in: "body",
          required: false,
          hint: "omit to auto-detect",
        },
        {
          key: "formality",
          label: "Formality",
          in: "body",
          required: false,
          hint: "default | more | less | prefer_more | prefer_less",
        },
        {
          key: "context",
          label: "Context",
          in: "body",
          required: false,
          hint: "surrounding text that is NOT translated, to disambiguate",
        },
        {
          key: "glossary_id",
          label: "Glossary id",
          in: "body",
          required: false,
        },
      ],
    },
    {
      key: "get_usage",
      label: "Get usage",
      description: "Read the key's character usage and quota for the period.",
      method: "GET",
      pathTemplate: "/v2/usage",
      write: false,
      fields: [],
    },
    {
      key: "list_languages",
      label: "List languages",
      description: "List the supported source or target languages.",
      method: "GET",
      pathTemplate: "/v2/languages",
      write: false,
      fields: [
        {
          key: "type",
          label: "Type",
          in: "query",
          required: false,
          hint: "source (default) | target",
        },
      ],
    },
  ],
};
