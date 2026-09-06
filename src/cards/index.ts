import { registerCards } from "../kernel/registry";
import { magicuiCards } from "./magicui";
import { nativeCards } from "./native";

registerCards([...magicuiCards, ...nativeCards]);
