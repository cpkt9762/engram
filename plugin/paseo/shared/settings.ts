import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
export const preferences = defineSettings({ id: "engram", scope: "host", version: 1, schema: z.object({
  baseUrl: z.string().default("http://127.0.0.1:7437"),
}) });
