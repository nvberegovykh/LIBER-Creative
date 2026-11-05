import { shell } from "./client.mjs";
shell(location.pathname.startsWith("/declaration") ? "Declaration" : "");
