import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle, type FauxResponseFactory, type Provider, type TranscriptContext } from "@earendil-works/pi-ai";

export function isSettingsTitleRequest(context: TranscriptContext): boolean {
  return context.messages.some((message) => message.role === "system" && JSON.stringify(message).includes("This is a Settings Assistant session title"));
}

/** Keep asynchronous title requests from consuming a fixture's ordered settings/tool responses. */
export function routeSettingsTitleRequests(handle: FauxProviderHandle, respond: FauxResponseFactory = () => fauxAssistantMessage('{"title":null}')): Provider {
  const titles = fauxProvider({ api: handle.api, provider: handle.provider.id, models: handle.models.map((model) => ({ id: model.id })) });
  return {
    ...handle.provider,
    stream(model, context, options) {
      if (!isSettingsTitleRequest(context)) return handle.provider.stream(model, context, options);
      titles.appendResponses([respond]);
      return titles.provider.stream(model, context, options);
    },
    streamSimple(model, context, options) {
      if (!isSettingsTitleRequest(context)) return handle.provider.streamSimple(model, context, options);
      titles.appendResponses([respond]);
      return titles.provider.streamSimple(model, context, options);
    },
  };
}
