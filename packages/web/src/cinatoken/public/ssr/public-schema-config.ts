/* Copyright (C) 2023-2026 CinaGroup. SPDX-License-Identifier: AGPL-3.0-or-later */
import { z } from 'zod'

// Browser CSP disallows eval. Configure this before loading any application
// schemas so Zod uses its interpreter without probing Function construction.
z.config({ jitless: true })
