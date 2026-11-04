import Link from "next/link";
import { listThreads, getThreadMessages } from "@/lib/assistant-memory";
import { sansBloquer } from "@/lib/journal";

/**
 * L'HISTORIQUE DU BUREAU D'ADAM, GELÉ EN LECTURE (lot I6, décision 0070).
 *
 * Le Bureau parlait à l'ANCIEN moteur, qui écrivait ses conversations dans `AssistantThread`. Adam n'a plus qu'un moteur
 * (Adventum IA, `/assistant`) : le Bureau ne joue plus de tour, et `AssistantThread` n'est plus écrit. Mais rien n'est
 * perdu : chaque conversation passée reste consultable ici, telle quelle, en lecture seule. ADAM_ANCIEN_MOTEUR=1 remet
 * le Bureau d'avant.
 */
export async function HistoriqueGele({ userId, fil }: { userId: string; fil: string | null }) {
  const fils = await listThreads(userId, 60).catch(sansBloquer("bureau.historique-gele.listThreads", []));
  const ouvert = fil && fils.some((f) => f.id === fil) ? fil : null;
  const messages = ouvert ? await getThreadMessages(userId, ouvert, 300).catch(sansBloquer("bureau.historique-gele.messages", null)) : null;
  const date = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4" data-testid="bureau-historique-gele">
      <div className="rounded-xl border border-border bg-secondary/40 p-4 text-sm">
        <p className="font-medium">Adam n&apos;a plus qu&apos;un seul moteur.</p>
        <p className="mt-1 text-muted-foreground">
          Pour lui parler — par écrit, par message vocal ou en conversation vocale — ouvrez{" "}
          <Link href="/assistant" className="font-medium text-primary hover:underline">la conversation d&apos;Adam</Link>.
          Les échanges du Bureau d&apos;avant restent consultables ci-dessous, en lecture seule.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-[18rem_1fr]">
        <nav aria-label="Conversations du Bureau" className="space-y-1">
          {fils.length === 0 && <p className="text-sm text-muted-foreground">Aucune conversation passée.</p>}
          {fils.map((f) => (
            <Link key={f.id} href={`/adam/bureau?fil=${encodeURIComponent(f.id)}`}
              className={`block rounded-lg border px-3 py-2 text-sm ${f.id === ouvert ? "border-primary/50 bg-primary/5" : "border-border hover:border-primary/30"}`}>
              <span className="block truncate font-medium">{f.title}</span>
              <span className="text-xs text-muted-foreground">{date(f.updatedAt)} · {f.messages} message{f.messages > 1 ? "s" : ""}</span>
            </Link>
          ))}
        </nav>
        <section aria-label="Messages" className="min-w-0 space-y-3">
          {!ouvert && fils.length > 0 && <p className="text-sm text-muted-foreground">Choisissez une conversation pour la relire.</p>}
          {(messages ?? []).map((m, i) => (
            <div key={i} className={`rounded-lg border p-3 text-sm ${m.role === "user" ? "border-border bg-background" : "border-primary/20 bg-primary/5"}`}>
              <p className="mb-1 text-xs font-medium text-muted-foreground">{m.role === "user" ? "Vous" : "Adam"} · {date(m.createdAt)}</p>
              <p className="whitespace-pre-wrap leading-relaxed">{m.content}</p>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
