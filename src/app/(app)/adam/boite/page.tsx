import Link from "next/link";
import { ArrowLeft, Inbox } from "lucide-react";
import { ouvrirInbox } from "@/platform/in-process/inbox/compose";
import { aTrancher } from "@/lib/assistant/inbox/model";
import { InboxView } from "@/components/chief/inbox/inbox-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Boîte de réception — Adam" };

/**
 * LA BOÎTE DE DÉCISION (§21) — tout ce qui attend UN geste de cette personne, en cartes.
 *
 * Elle vit dans le bureau d'Adam parce que c'est là que le dirigeant est, mais elle ne dépend
 * pas d'un appel de modèle : les cartes sont composées par le code (`composerInbox`), depuis
 * les mêmes files que les modules (validations, centre de paiement, accords de mission,
 * notifications, engagements, décisions à revoir). Chaque bouton est l'action canonique du
 * module, pas une écriture propre à cet écran.
 */
export default async function InboxPage() {
  const { vue } = await ouvrirInbox();
  const n = vue.cartes.length;

  return (
    <div className="chief-scroll chief-inbox-page">
      <div className="chief-inbox-tete">
        <Link href="/adam/bureau" className="chief-icon-btn" aria-label="Revenir au bureau d'Adam"><ArrowLeft className="h-5 w-5" aria-hidden /></Link>
        <h1 className="chief-title flex items-center gap-2"><Inbox className="h-5 w-5" aria-hidden /> Boîte de décision</h1>
        <p className="chief-meta">{n === 0 ? "rien en attente" : `${n} carte${n > 1 ? "s" : ""} · ${aTrancher(vue.compte)} à trancher`}</p>
      </div>
      <InboxView cartes={vue.cartes} compte={vue.compte} ms={vue.ms} />
    </div>
  );
}
