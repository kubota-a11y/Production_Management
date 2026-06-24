// ========================================
// ユーティリティ関数
// ========================================

// 日付フォーマット（YYYY-MM-DD → YYYY年M月D日）
function formatDate(dateStr) {
  if (!dateStr) return '';
  const [year, month, day] = dateStr.split('-');
  return `${year}年${parseInt(month)}月${parseInt(day)}日`;
}

// ISO 8601 → 日本語フォーマット
function formatDateTime(isoStr) {
  if (!isoStr) return '';
  const date = new Date(isoStr);
  return date.toLocaleString('ja-JP');
}

// ステータス日本語変換
function getStatusLabel(status) {
  const statusMap = {
    'PRE_ORDER': '受注前',
    'CONFIRMED': '受注確定',
    'WAITING': '生産待ち',
    'IN_PROGRESS': '生産中',
    'INSPECTION': '検品',
    'DELIVERED': '納品済'
  };
  return statusMap[status] || status;
}

// ステータスCSSクラス
function getStatusClass(status) {
  const classMap = {
    'PRE_ORDER': 'status-pre-order',
    'CONFIRMED': 'status-confirmed',
    'WAITING': 'status-waiting',
    'IN_PROGRESS': 'status-in-progress',
    'INSPECTION': 'status-inspection',
    'DELIVERED': 'status-delivered'
  };
  return classMap[status] || '';
}

// 加工種別日本語変換
function getProcessLabel(process) {
  const processMap = {
    'PRINT': 'プリント',
    'EMBROIDERY': '刺繍',
    'COMBINED': '複合'
  };
  return processMap[process] || process;
}

// 優先度日本語変換
function getPriorityLabel(priority) {
  const priorityMap = {
    'HIGH': '高',
    'MEDIUM': '中',
    'LOW': '低'
  };
  return priorityMap[priority] || priority;
}

// 優先度CSSクラス
function getPriorityClass(priority) {
  const classMap = {
    'HIGH': 'priority-high',
    'MEDIUM': 'priority-medium',
    'LOW': 'priority-low'
  };
  return classMap[priority] || '';
}

// 納期警告フラグ
function getDeadlineWarning(deadline) {
  if (!deadline) return '';
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const deadlineDate = new Date(deadline);
  deadlineDate.setHours(0, 0, 0, 0);
  
  const diffTime = deadlineDate - today;
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  
  if (diffDays < 0) return 'overdue';
  if (diffDays <= 3) return 'urgent';
  if (diffDays <= 7) return 'warning';
  return '';
}

// 職種日本語変換
function getRoleLabel(role) {
  const roleMap = {
    'FULL_TIME': 'フルタイム',
    'PART_TIME': 'パート',
    'PRODUCTION_MANAGER': '生産管理',
    'DESIGNER': 'デザイナー'
  };
  return roleMap[role] || role;
}

// テキスト抽出: 日付を探す（複数フォーマット対応）
function extractDate(text) {
  // 2024/12/25, 2024-12-25, 12/25, 12月25日など
  const patterns = [
    /(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/,  // YYYY/MM/DD
    /(\d{1,2})[\/\-月](\d{1,2})[日]?/             // MM/DD または M月D日
  ];
  
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      let year, month, day;
      if (match[0].includes('年')) {
        // 2024年12月25日形式
        year = match[1];
        month = String(match[2]).padStart(2, '0');
        day = String(match[3]).padStart(2, '0');
      } else if (match.length === 4) {
        // YYYY/MM/DD または MM/DD
        if (match[1].length === 4) {
          year = match[1];
          month = String(match[2]).padStart(2, '0');
          day = String(match[3]).padStart(2, '0');
        } else {
          const today = new Date();
          year = today.getFullYear();
          month = String(match[1]).padStart(2, '0');
          day = String(match[2]).padStart(2, '0');
        }
      }
      if (year && month && day) {
        return `${year}-${month}-${day}`;
      }
    }
  }
  return null;
}

// テキスト抽出: 数字を探す（数量）
function extractNumber(text) {
  const match = text.match(/(\d+)\s*(?:個|枚|件|セット)/);
  return match ? parseInt(match[1]) : null;
}

// テキスト抽出: 名前を推測
function extractName(text) {
  // 行ごとに分割
  const lines = text.split('\n');
  // 最初の行から名前らしいテキストを抽出
  const firstLine = lines[0];
  return firstLine.replace(/\s*/g, '').substring(0, 50);
}
