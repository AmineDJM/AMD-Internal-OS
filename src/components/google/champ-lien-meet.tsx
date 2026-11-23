"use client";

import * as React from "react";
import Link from "next/link";
import { Loader2, Video, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Retour } from "@/components/ui/retour";
import { useConfirmer } from "@/components/ui/dialogue";
import { MESSAGE_REFUS_MEET, type ReponseLienMeet } from "@/lib/google/calendar/meet-regles";

/**
 * LE CHAMP « LIEN VISIO » AVEC SON BOUTON « GÉNÉRER UN LIEN GOOGLE MEET ».
 *
 * Le bouton lit le titre et les dates DANS LE FORMULAIRE qui contient le champ (les noms sont
 * donnés par `champs`), demande à la route `/api/google/meet` de créer la réunion dans l'agenda
 * Google de l'entreprise, et pose le lien rendu dans le champ. C'est l'enregistrement du
 * formulaire qui l'écrit avec la réunion ou l'événement — le champ reste un champ ordinaire, qu'on
 * peut encore remplir à la main (Teams, Zoom…).
 *
 * Composant CLIENT : il n'importe que les règles PURES (`meet-regles.ts` : types et phrases) ; l'appel
 * à Google passe par `fetch`, jamais par le module Google lui-même (`client-bundle-guard.test.ts`).
 */
export function ChampLienMeet({
  id, name, defaultValue, placeholder = "https://meet.google.com/…", type = "text", champs,
}: {
  id?: string;
  name: string;
  defaultValue?: string | null;
  placeholder?: string;
  type?: "text" | "url";
  /** Les noms des champs du même formulaire : le titre (obligatoire), le début, la fin, la case « journée entière ». */
  champs: { titre: string; debut?: string; fin?: string; journeeEntiere?: string };
}) {
  const champ = React.useRef<HTMLInputElement>(null);
  const confirmer = useConfirmer();
  const [enCours, setEnCours] = React.useState(false);
  const [retour, setRetour] = React.useState<ReponseLienMeet | null>(null);

  async function generer() {
    const input = champ.current;
    const form = input?.form;
    if (!input || !form) return;
    const fd = new FormData(form);
    const lire = (n?: string) => (n ? String(fd.get(n) ?? "").trim() : "");
    const titre = lire(champs.titre);
    if (!titre) {
      setRetour({ ok: false, raison: "invalide", message: MESSAGE_REFUS_MEET.invalide });
      const t = form.elements.namedItem(champs.titre);
      if (t instanceof HTMLElement) t.focus();
      return;
    }
    if (input.value.trim() && !(await confirmer({
      titre: "Remplacer le lien actuel ?",
      message: "Un nouveau lien Google Meet sera créé et remplacera celui du champ.",
      confirmer: "Générer un nouveau lien",
    }))) return;

    setEnCours(true);
    setRetour(null);
    try {
      const res = await fetch("/api/google/meet", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          titre,
          debut: lire(champs.debut) || null,
          fin: lire(champs.fin) || null,
          journeeEntiere: champs.journeeEntiere ? fd.get(champs.journeeEntiere) !== null : false,
        }),
      });
      const r = (await res.json().catch(() => null)) as ReponseLienMeet | null;
      if (!r) {
        setRetour({ ok: false, raison: "google-indisponible", message: "Le serveur n'a pas répondu. Réessayez dans un instant." });
        return;
      }
      if (r.ok) {
        // Le setter natif + l'événement `input` : le champ est mis à jour comme si on l'avait tapé.
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, r.lien);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
      setRetour(r);
    } catch {
      setRetour({ ok: false, raison: "google-indisponible", message: "Le serveur est injoignable. Vérifiez la connexion et réessayez." });
    } finally {
      setEnCours(false);
    }
  }

  return (
    <div className="space-y-2">
      <Input
        ref={champ}
        id={id}
        name={name}
        type={type}
        inputMode="url"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        defaultValue={defaultValue ?? ""}
        placeholder={placeholder}
      />
      <Button type="button" variant="outline" size="sm" onClick={generer} disabled={enCours} className="w-full sm:w-auto">
        {enCours ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
        {enCours ? "Création du lien…" : "Générer un lien Google Meet"}
      </Button>
      {retour?.ok && (
        <Retour ton="succes" onFermer={() => setRetour(null)}>
          Lien créé dans Google Agenda ({retour.compte}) — il sera enregistré avec le formulaire.{" "}
          <a href={retour.lien} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline">
            Ouvrir dans Google Meet <ExternalLink className="h-3 w-3" />
          </a>
        </Retour>
      )}
      {retour && !retour.ok && (
        <Retour ton="erreur" onFermer={() => setRetour(null)}>
          {retour.message}
          {retour.reglages && (
            <>
              {" "}
              <Link href={retour.reglages} className="font-medium underline">Ouvrir les réglages Google</Link>
            </>
          )}
        </Retour>
      )}
    </div>
  );
}
