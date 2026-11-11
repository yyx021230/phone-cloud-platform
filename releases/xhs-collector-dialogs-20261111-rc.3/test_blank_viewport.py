import copy
import importlib.util
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

RELEASE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("viewport_candidate", (Path(__file__).resolve().parents[2] / "windows-agent/scripts/小红书数据同步.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


def blank(spinner=True):
    root = ET.Element("hierarchy")
    def node(parent, kind, box, rid="", clickable="false"):
        return ET.SubElement(parent, "node", {"package": sync.XHS_PACKAGE, "class": "android." + kind,
            "bounds": box, "enabled": "true", "clickable": clickable, "resource-id": rid, "text": ""})
    frame = node(root, "widget.FrameLayout", "[0,0][720,1600]")
    content = node(frame, "widget.FrameLayout", "[0,0][720,1516]", "android:id/content")
    node(content, "webkit.WebView", "[0,0][720,1516]", clickable="true")
    if spinner:
        node(content, "widget.ImageView", "[326,724][394,792]")
    node(frame, "view.View", "[0,1516][720,1600]", "android:id/navigationBarBackground")
    return root


class ViewportTests(unittest.TestCase):
    def test_saved_owner_and_clone_layouts_are_loading_and_never_empty_results(self):
        for spinner in (True, False):
            root = blank(spinner)
            self.assertTrue(sync.blank_works_loading(root))
            self.assertFalse(sync.creator_list(root))
            self.assertFalse(sync.proven_display_empty_state(root))

    def test_out_of_content_viewport_foreign_text_and_multiple_content_are_rejected(self):
        for kind in ("viewport", "foreign", "text", "duplicate"):
            root = blank()
            nodes = list(root.iter("node"))
            if kind == "viewport":
                nodes[2].set("bounds", "[0,0][720,1600]")
            elif kind == "foreign":
                nodes[2].set("package", "com.other")
            elif kind == "text":
                nodes[2].set("text", "未知页面")
            else:
                root.append(copy.deepcopy(nodes[1]))
            self.assertFalse(sync.blank_works_loading(root))

    def test_no_spinner_does_not_accept_an_unlabelled_button_as_a_loading_page(self):
        root = blank(False)
        ET.SubElement(root, "node", {"package": sync.XHS_PACKAGE, "class": "android.widget.Button",
            "bounds": "[1,1][2,2]", "enabled": "true", "text": ""})
        self.assertFalse(sync.blank_works_loading(root))


if __name__ == "__main__":
    unittest.main()
