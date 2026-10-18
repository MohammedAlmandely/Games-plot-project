// shared.js — Games Plot
// دوال مشتركة بين الصفحات: تنقية النصوص (منع XSS) وحساب الرتبة/الـ XP
// يتم تحميلها بـ <script src="shared.js"></script> قبل السكربتات الأخرى

// ✅ تنقية أي نص قادم من المستخدم قبل إدخاله في innerHTML (منع XSS)
function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ✅ نسخة واحدة موحّدة لحساب الرتبة/المستوى (بدل تكرارها في 3 ملفات مختلفة)
function getPlayerRank(totalXP) {
    totalXP = totalXP || 0;
    let level, rankName, color, xpInLevel, xpPerLevel, nextRankXP;

    if (totalXP <= 1000) {
        xpPerLevel = 100;
        level = Math.floor(totalXP / xpPerLevel);
        xpInLevel = totalXP % xpPerLevel;
        rankName = "مبتدئ"; color = "#9ca3af";
        nextRankXP = 1000;
    } else if (totalXP <= 3500) {
        xpPerLevel = 250;
        level = 10 + Math.floor((totalXP - 1000) / xpPerLevel);
        xpInLevel = (totalXP - 1000) % xpPerLevel;
        rankName = "مغامر"; color = "#22c55e";
        nextRankXP = 3500;
    } else if (totalXP <= 18500) {
        xpPerLevel = 500;
        level = 20 + Math.floor((totalXP - 3500) / xpPerLevel);
        xpInLevel = (totalXP - 3500) % xpPerLevel;
        rankName = "محترف"; color = "#3b82f6";
        nextRankXP = 18500;
    } else {
        xpPerLevel = 1000;
        level = 50 + Math.floor((totalXP - 18500) / xpPerLevel);
        xpInLevel = (totalXP - 18500) % xpPerLevel;
        rankName = "أسطورة"; color = "#f59e0b";
        nextRankXP = null; // لا يوجد رتبة أعلى حالياً
    }

    return {
        level, rankName, color, xpInLevel, xpPerLevel, nextRankXP,
        progressPct: Math.min((xpInLevel / xpPerLevel) * 100, 100)
    };
}
