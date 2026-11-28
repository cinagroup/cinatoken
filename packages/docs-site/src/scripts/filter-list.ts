/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
for (const root of document.querySelectorAll<HTMLElement>(
	"[data-filter-list]",
)) {
	const query = root.querySelector<HTMLInputElement>("[data-catalog-query]")!,
		vendor = root.querySelector<HTMLSelectElement>("[data-catalog-vendor]")!,
		kind = root.querySelector<HTMLSelectElement>("[data-catalog-kind]"),
		status = root.querySelector("[data-catalog-status]")!,
		previous = root.querySelector<HTMLButtonElement>(
			"[data-catalog-previous]",
		)!,
		next = root.querySelector<HTMLButtonElement>("[data-catalog-next]")!,
		rows = [...root.querySelectorAll<HTMLElement>("[data-catalog-row]")];
	const copy = JSON.parse(root.dataset.copy!) as Record<string, string>,
		limit = Number(root.dataset.pageSize) || 20,
		filterParam = root.dataset.filterParam || "vendor";
	let page = 1;
	const initial = new URLSearchParams(location.search);
	query.value = (initial.get("q") || "").slice(0, 200);
	query.maxLength = 200;
	vendor.value = initial.get(filterParam) || "";
	if (vendor.selectedIndex < 0) vendor.value = "";
	if (kind) {
		kind.value = initial.get("kind") || "";
		if (kind.selectedIndex < 0) kind.value = "";
	}
	const initialPage = Number(initial.get("page"));
	if (Number.isInteger(initialPage) && initialPage > 0) page = initialPage;
	const render = () => {
		const q = query.value.trim().toLowerCase(),
			filtered = rows.filter(
				(row) =>
					(!vendor.value || row.dataset.vendor === vendor.value) &&
					(!kind?.value || row.dataset.kind === kind.value) &&
					(!q || row.dataset.search?.includes(q)),
			),
			pages = Math.max(1, Math.ceil(filtered.length / limit));
		page = Math.min(page, pages);
		rows.forEach((row) => (row.hidden = true));
		filtered
			.slice((page - 1) * limit, page * limit)
			.forEach((row) => (row.hidden = false));
		status.textContent = filtered.length
			? copy
					.status!.replace("{n}", String(filtered.length))
					.replace("{page}", String(page))
					.replace("{pages}", String(pages))
			: copy.empty!;
		previous.disabled = page === 1;
		next.disabled = page === pages;
		const url = new URL(location.href);
		for (const [name, value] of [
			["q", query.value.trim()],
			[filterParam, vendor.value],
			["kind", kind?.value || ""],
			["page", page === 1 ? "" : String(page)],
		]) {
			if (value) url.searchParams.set(name!, value);
			else url.searchParams.delete(name!);
		}
		history.replaceState(null, "", url.pathname + url.search + url.hash);
	};
	query.disabled = false;
	vendor.disabled = false;
	if (kind) kind.disabled = false;
	for (const control of [query, vendor, kind])
		control?.addEventListener("input", () => {
			page = 1;
			render();
		});
	previous.addEventListener("click", () => {
		page--;
		render();
		root.scrollIntoView({ block: "start" });
	});
	next.addEventListener("click", () => {
		page++;
		render();
		root.scrollIntoView({ block: "start" });
	});
	render();
}
