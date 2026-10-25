import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/** L'assistant n'a plus qu'une adresse : `/assistant` (même interface, même garde). */
export default function AssistantBetaPage() {
  redirect("/assistant");
}
