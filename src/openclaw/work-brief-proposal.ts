import { Type } from "typebox";
import { isRecord } from "../shared/type-guards.js";

const text = () => Type.String({ minLength: 1, maxLength: 4000 });
const list = () => Type.Array(text(), { maxItems: 16 });
export const CANDIDATE_PARAMETERS = Type.Object({
  topic: text(), interpretation: text(), proposedPremises: list(), openQuestions: list(), evidenceReferences: list(),
}, { additionalProperties: false });
export type Proposal = {
  topic: string; interpretation: string; proposedPremises: string[];
  openQuestions: string[]; evidenceReferences: string[];
};
const keys = ["topic", "interpretation", "proposedPremises", "openQuestions", "evidenceReferences"];
const validText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4000;
const validList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 16 && value.every(validText);
export function parseProposal(value: unknown): Proposal {
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key)) ||
      !validText(value.topic) || !validText(value.interpretation) ||
      !validList(value.proposedPremises) || !validList(value.openQuestions) || !validList(value.evidenceReferences)) {
    throw new Error("stella_candidate_arguments_invalid");
  }
  return structuredClone(value) as Proposal;
}
