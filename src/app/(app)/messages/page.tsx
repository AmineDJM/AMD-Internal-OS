import { requireModule } from "@/lib/session";
import { hasGlobalView } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import {
  getConversationSummaries,
  getDirectory,
  getDiscoverableChannels,
  getConversationDetail,
} from "@/lib/queries/messaging";
import { Messenger } from "./messenger";

export const dynamic = "force-dynamic";

export default async function MessagesPage(props: { searchParams: Promise<{ c?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireModule("MESSAGING");

  const [me, conversations, directory, channels] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { avatarColor: true, chatStatus: true, statusMessage: true } }),
    getConversationSummaries(user.id),
    getDirectory(user.id),
    getDiscoverableChannels(user.id),
  ]);

  const wanted = searchParams.c ?? null;
  const initialDetail = wanted ? await getConversationDetail(user.id, wanted) : null;
  const initialActiveId = initialDetail ? wanted : null;

  // Modération transverse : la CHAÎNE `user.role`, exactement ce que lit `deleteMessage`.
  // L'écran ne doit ni offrir ni cacher autre chose que ce que l'action accepte.
  return (
    <Messenger
      selfId={user.id}
      selfName={user.name}
      vueGlobale={hasGlobalView(user.role)}
      selfColor={me?.avatarColor ?? null}
      selfStatus={me?.chatStatus ?? null}
      selfStatusMessage={me?.statusMessage ?? null}
      initialConversations={conversations}
      initialActiveId={initialActiveId}
      initialDetail={initialDetail}
      directory={directory}
      channels={channels}
    />
  );
}
