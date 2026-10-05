"use client";

/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import dynamic from "next/dynamic";

// Load the shared browser-only editor after hydration so safety storage is never
// initialized on the server. The legacy route retains its existing URL.
const LegacyToolsShell = dynamic(() => import("./LegacyToolsShell"), {
	ssr: false,
});
export default function AdminToolsPage() {
	return <LegacyToolsShell />;
}
