import { Hono } from "hono";

export const app = new Hono();

app.get("/", (c) => c.html("<h1>Hello Broken</h1>"));
