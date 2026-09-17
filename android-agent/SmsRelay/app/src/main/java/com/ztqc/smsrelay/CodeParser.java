package com.ztqc.smsrelay;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class CodeParser {
    private static final Pattern[] CODE_PATTERNS = new Pattern[] {
        Pattern.compile("(?:验证码|校验码|动态码|验证代码|确认码|短信码|code|Code|CODE)[^0-9A-Za-z]{0,18}([A-Za-z0-9]{4,8})"),
        Pattern.compile("([A-Za-z0-9]{4,8})(?:\\s*为|是|，|。|\\.|,)?[^，。,.]{0,24}(?:验证码|校验码|动态码|验证代码|确认码|短信码)")
    };

    private static final String[] PLATFORMS = new String[] {
        "小红书", "抖音", "微信", "支付宝", "淘宝", "京东", "美团", "拼多多", "快手", "微博", "百度", "腾讯", "阿里云", "懂车帝"
    };

    private CodeParser() {}

    public static String extractCode(String body) {
        String text = body == null ? "" : body.replaceAll("\\s+", " ");
        for (Pattern pattern : CODE_PATTERNS) {
            Matcher matcher = pattern.matcher(text);
            if (matcher.find()) return matcher.group(1);
        }
        return "";
    }

    public static String detectPlatform(String sender, String body) {
        String text = String.valueOf(sender) + " " + String.valueOf(body);
        for (String platform : PLATFORMS) {
            if (text.contains(platform)) return platform;
        }
        return sender == null || sender.isEmpty() ? "未知平台" : sender;
    }
}
