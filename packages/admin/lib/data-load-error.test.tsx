import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { DataLoadError } from "../components/DataLoadError";
import { GatewaySetupGuide } from "../components/gateway/GatewaySetupGuide";
import en from "../messages/en.json";
import zh from "../messages/zh.json";
import ja from "../messages/ja.json";
import ko from "../messages/ko.json";

for (const [locale, messages] of Object.entries({ en, zh, ja, ko })) {
	test(`setup guide includes the public endpoint publication gate in ${locale}`, () => {
		const html = renderToStaticMarkup(
			<NextIntlClientProvider
				locale={locale}
				messages={messages}
				timeZone="UTC"
			>
				<GatewaySetupGuide activeStep="endpoint" />
			</NextIntlClientProvider>
		);
		assert.ok(html.includes('href="/admin/endpoints"'));
		assert.ok(html.includes(messages.gatewaySetup.steps.endpoint.title));
		assert.equal((html.match(/<li>/g) ?? []).length, 4);
	});
	test(`data failure renders an accessible error and retry in ${locale}, not a zero balance`, () => {
		const html = renderToStaticMarkup(
			<NextIntlClientProvider
				locale={locale}
				messages={messages}
				timeZone="UTC"
			>
				<DataLoadError onRetry={() => undefined} />
			</NextIntlClientProvider>
		);
		assert.ok(html.includes('role="alert"'));
		assert.ok(html.includes(messages.common.retry));
		assert.ok(html.includes(messages.common.dataLoadFailed));
		assert.ok(!html.includes("$0.00"));
	});
}
