import json
import os
import sys

from faster_whisper import WhisperModel


LANGUAGE_CODES = {
    "arabic": "ar",
    "chinese": "zh",
    "english": "en",
    "french": "fr",
    "german": "de",
    "italian": "it",
    "portuguese": "pt",
    "spanish": "es",
}

ARABIC_REPLACEMENTS = {
    "اسبانيا": "إسبانيا",
    "اسرائيل": "إسرائيل",
    "اسرائيلي": "إسرائيلي",
    "الاسرائيلي": "الإسرائيلي",
    "الإسرائلي": "الإسرائيلي",
    "الاسرائيلية": "الإسرائيلية",
    "الاسرائيليين": "الإسرائيليين",
    "الشعب الفلسطني": "الشعب الفلسطيني",
    "الفلسطني": "الفلسطيني",
    "فلسطاني": "فلسطيني",
    "مسبوغ": "مسبوق",
    "مسبوخ": "مسبوق",
    "قامنية": "قانونية",
    "قامنونية": "قانونية",
    "تباطوها": "تواطؤها",
    "تباطؤها": "تواطؤها",
    "تواطئها": "تواطؤها",
    "العدول إسرائيل للدشعبنا": "العدو الإسرائيلي ضد شعبنا",
    "العدول إسرائيل": "العدو الإسرائيلي",
    "العدو إسرائيل": "العدو الإسرائيلي",
    "الدشعبنا": "ضد شعبنا",
    "متوارضة بالشدة": "متورطة بشدة",
    "متوارضة بشدة": "متورطة بشدة",
    "متورطة بالشدة": "متورطة بشدة",
    "الشدة في": "بشدة في",
    "كاف متوارضة": "كاف متورطة",
    "كاف متورطة بالشدة": "كاف متورطة بشدة",
    "الخطر الأحمر": "الخط الأحمر",
    "الخطر الأخضر": "الخط الأخضر",
    "الخد الأحمر": "الخط الأحمر",
    "الخد الأخضر": "الخط الأخضر",
    "الخطوط المستعمرات": "الخطوط المستعمرات",
    "تربب": "تربط",
    "تريب": "تربط",
    "فلسطانية": "فلسطينية",
    "فلسطانية مسلوبة": "فلسطينية مسلوبة",
    "التهجير القصري": "التهجير القسري",
    "التهجير القصرى": "التهجير القسري",
    "الأمام متحدة": "الأمم المتحدة",
    "الأمام المتحدة": "الأمم المتحدة",
    "الأمم متحدة": "الأمم المتحدة",
    "ما حدر": "ما حذر",
    "ما حدر منه": "ما حذر منه",
    "المجتمع المدن": "المجتمع المدني",
    "المجتمع المدنى": "المجتمع المدني",
    "محكمت العدد الدولية": "محكمة العدل الدولية",
    "محكمة العدد الدولية": "محكمة العدل الدولية",
    "محكمة العدل الدولي": "محكمة العدل الدولية",
    "الاحتلال العسكر": "الاحتلال العسكري",
    "الغدبية": "الغربية",
    "الغربيه": "الغربية",
    "وصحب الاستثمرات": "وسحب الاستثمارات",
    "وصحب الاستثمارات": "وسحب الاستثمارات",
    "وسحب الاستثماراة": "وسحب الاستثمارات",
    "فرض العقوبات BDS": "فرض العقوبات BDS",
    "بدأس": "BDS",
    "بي دي أس": "BDS",
    "بي دي اس": "BDS",
    "بي دي إس": "BDS",
    "ألستوم": "ألستوم",
    "الستوم": "ألستوم",
    "فيوليا": "فيوليا",
    "فويلية": "فيوليا",
    "فيولية": "فيوليا",
    "المشروع داته": "المشروع ذاته",
    "ذاته": "ذاته",
    "حمل عالمية": "حملة عالمية",
    "حملة عالمية لحركة المقاطع بدأس": "حملة عالمية لحركة المقاطعة BDS",
    "حركة المقاطع": "حركة المقاطعة",
    "إضربات": "إضرابات",
    "اضرابات": "إضرابات",
    "في في المصانع": "في المصانع",
    "دور مثل النروج": "دول مثل النرويج",
    "دور مثل النرويج": "دول مثل النرويج",
    "النروج": "النرويج",
    "ادارة": "إدارة",
    "واسعة الشركة": "وسعت الشركة",
    "وساعة الشركة": "وسعت الشركة",
    "إبادت شعبنا": "إبادة شعبنا",
    "إبادت شعبنا": "إبادة شعبنا",
    "مسائلة الشركات": "مساءلة الشركات",
    "مساءلة الشركات في اسبانيا": "مساءلة الشركات في إسبانيا",
    "البسكية": "الباسكية",
    "البسكيه": "الباسكية",
    "محمين دوليين": "محامين دوليين",
    "محامين دولين": "محامين دوليين",
    "ندرو أحرار": "ندعو أحرار",
    "ندرو احرار": "ندعو أحرار",
    "تصييد الحملة": "تصعيد الحملة",
    "تصعيد الحمله": "تصعيد الحملة",
    "التواطق": "التواطؤ",
    "التواطئ": "التواطؤ",
    "الأبرتايد الإسرائيل": "الأبرتايد الإسرائيلي",
    "الابرتايد": "الأبرتايد",
    "الأبارتايد": "الأبرتايد",
    "نظام الاستعمار الاستطاني": "نظام الاستعمار الاستيطاني",
    "الاستعمار الاستطاني": "الاستعمار الاستيطاني",
}

ARABIC_PHRASE_REPLACEMENTS = {
    "شركة تصنيع القطارات الباسكية كاف": "شركة تصنيع القطارات الباسكية CAF",
    "شركة كاف": "شركة CAF",
    "حركة المقاطعة BDS": "حركة المقاطعة BDS",
}


def normalize_language(language):
    if not language or language == "Auto detect":
        return None
    return LANGUAGE_CODES.get(language.lower(), language.lower()[:2])


def clean_text(text, language_code):
    if language_code != "ar":
        return text
    cleaned = text
    for wrong, right in ARABIC_REPLACEMENTS.items():
        cleaned = cleaned.replace(wrong, right)
    for wrong, right in ARABIC_PHRASE_REPLACEMENTS.items():
        cleaned = cleaned.replace(wrong, right)
    cleaned = " ".join(cleaned.split())
    return cleaned


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")

    if len(sys.argv) < 2:
        raise SystemExit("Usage: python transcribe_local.py <media-file> [language]")

    media_file = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else "Auto detect"
    speed = sys.argv[3] if len(sys.argv) > 3 else "balanced"
    language_code = normalize_language(language)
    if speed in ("fast", "balanced"):
        model_name = os.getenv("LOCAL_WHISPER_FAST_EN_MODEL" if language_code == "en" else "LOCAL_WHISPER_FAST_MODEL", "small")
    else:
        model_name = os.getenv("LOCAL_WHISPER_EN_MODEL" if language_code == "en" else "LOCAL_WHISPER_MODEL", "medium")

    beam_size = 2 if speed == "fast" else 4 if speed == "balanced" else 5
    best_of = 2 if speed == "fast" else 4 if speed == "balanced" else 5
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    transcribe_options = {
        "vad_filter": True,
        "beam_size": beam_size,
        "best_of": best_of,
        "condition_on_previous_text": False,
        "task": "transcribe",
        "temperature": 0,
        "compression_ratio_threshold": 2.4,
        "log_prob_threshold": -1.0,
        "no_speech_threshold": 0.6,
    }
    if language_code:
        transcribe_options["language"] = language_code

    segments, info = model.transcribe(media_file, **transcribe_options)
    detected_language = language_code or getattr(info, "language", None)
    normalized_segments = []
    full_text = []

    for segment in segments:
        text = clean_text(segment.text.strip(), detected_language)
        if not text:
            continue
        normalized_segments.append({
            "start": float(segment.start),
            "end": float(segment.end),
            "text": text,
        })
        full_text.append(text)

    print(json.dumps({
        "text": " ".join(full_text),
        "segments": normalized_segments,
        "provider": "local-whisper",
        "model": model_name,
        "language": detected_language or "auto",
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
