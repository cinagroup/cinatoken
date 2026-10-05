"use client";

/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import dynamic from "next/dynamic";

const LegacyChainOperationsShell = dynamic(
	() => import("@/components/chain-operations/LegacyChainOperationsShell"),
	{ ssr: false }
);

export default function AdminNftMintsPage() {
	return <LegacyChainOperationsShell feature="nft-mints" />;
}
