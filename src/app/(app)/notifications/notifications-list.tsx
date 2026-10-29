"use client";

import * as React from "react";
import Link from "next/link";
import { CheckCheck } from "lucide-react";
import { markNotificationRead, markAllNotificationsRead } from "@/lib/actions/notification-actions";
import { reécriteLienNotification } from "@/lib/notifications/lien-actuel";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { NOTIFICATION_TYPE } from "@/lib/labels";
import { formatDateTime, cn } from "@/lib/utils";

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  isRead: boolean;
  createdAt: string;
}

export function NotificationsList({ items }: { items: NotificationItem[] }) {
  const { rafraichir } = useRafraichir();
  // Marquées lues localement (optimiste) pour retirer la pastille dès le clic.
  const [readIds, setReadIds] = React.useState<Set<string>>(new Set());
  const isRead = (n: NotificationItem) => n.isRead || readIds.has(n.id);
  const hasUnread = items.some((n) => !isRead(n));

  // Cliquer une notification = la marquer comme lue (plus besoin de la coche).
  const markRead = (id: string, alreadyRead: boolean, refresh: boolean) => {
    if (alreadyRead) return;
    setReadIds((s) => new Set(s).add(id));
    void markNotificationRead(id).then(() => { if (refresh) rafraichir(); }, () => undefined);
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <form action={markAllNotificationsRead} className="w-full sm:w-auto">
          <Button type="submit" variant="outline" size="sm" disabled={!hasUnread} className="w-full sm:w-auto">
            <CheckCheck className="h-4 w-4" /> Tout marquer comme lu
          </Button>
        </form>
      </div>

      {items.length === 0 ? (
        <EmptyState icon="BellOff" title="Aucune notification" description="Vous êtes à jour." />
      ) : (
        <ul className="surface divide-y divide-border overflow-hidden">
          {items.map((n) => {
            const read = isRead(n);
            const content = (
              <div className="flex items-start gap-3 px-3 py-3 sm:px-4">
                <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", read ? "bg-transparent" : "bg-primary")} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <StatusBadge map={NOTIFICATION_TYPE} value={n.type} dot={false} />
                    <span className="text-xs text-muted-foreground">{formatDateTime(n.createdAt)}</span>
                  </div>
                  <p className={cn("mt-0.5 break-words text-sm", read ? "font-normal" : "font-medium")}>{n.title}</p>
                  {n.body && <p className="line-clamp-3 break-words text-sm text-muted-foreground sm:line-clamp-none">{n.body}</p>}
                </div>
              </div>
            );
            const lienActuel = reécriteLienNotification(n.link);
            return (
              <li key={n.id} className={cn(!read && "bg-accent/30")}>
                {lienActuel ? (
                  // Clic → navigation ET marquage lu.
                  <Link href={lienActuel} onClick={() => markRead(n.id, read, false)}>{content}</Link>
                ) : (
                  // Sans lien : le clic marque simplement comme lu.
                  <button type="button" onClick={() => markRead(n.id, read, true)} className="block w-full text-left">{content}</button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
