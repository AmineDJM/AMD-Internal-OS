import { Metadata } from "next";
import { requireModule } from "@/lib/session";
import { AssistantWorkspace } from "@/components/assistant-beta/assistant-workspace";

export const metadata: Metadata = {
  title: "Adventum Brain — Assistant IA",
  description: "Assistant interne intelligent sous Human Interface Guidelines et décor serein.",
};

export const dynamic = "force-dynamic";

export default async function AssistantPage() {
  const user = await requireModule("WORKSPACE");

  return (
    <div className="app-viewport-flush -mx-3 -mt-3 -mb-3 flex flex-col overflow-hidden sm:-mx-4 sm:-mt-6 sm:-mb-6 lg:-mx-8 lg:-mb-8">
      <AssistantWorkspace userName={user.name} userRole={user.role} />
    </div>
  );
}
