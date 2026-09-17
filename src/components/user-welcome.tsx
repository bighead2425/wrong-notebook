"use client";

import { useState, useEffect } from "react";

import { useSession, signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { LogOut, User } from "lucide-react";

export function UserWelcome() {
    const { data: session } = useSession();
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        setMounted(true);
    }, []);

    // Server always renders 'User' (no session). Client matches this initially.
    // After mount, we show the real name.
    const userName = mounted && session?.user ? (session.user.name || session.user.email) : 'User';

    return (
        <div className="flex items-center gap-2 bg-card p-4 rounded-lg border shadow-sm animate-in fade-in slide-in-from-top-4 duration-700">
            <User className="h-5 w-5 text-primary shrink-0" />
            {/* 只显示用户名，"欢迎回来，"前缀太长（用户要求精简） */}
            <span className="font-medium truncate">{userName}</span>
        </div>
    );
}
