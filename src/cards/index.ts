import { registerCards } from "../kernel/registry";
import { magicuiCards } from "./magicui";
import { nativeCards } from "./native";
import { probeCards } from "./_probe";

registerCards([...magicuiCards, ...nativeCards, ...probeCards]);
