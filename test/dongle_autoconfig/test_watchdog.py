import unittest

from dongle_autoconfig.plan import Plan, PlanItem
from dongle_autoconfig.watchdog import HealthState, WatchdogPolicy, evaluate


class WatchdogTests(unittest.TestCase):
    def make_plan(self):
        item = PlanItem("dongle0", "unchanged", "", "", "", "", "",
                        True, None)
        return Plan(slots=None, devices=[], config=None, generated=None,
                    items=[item])

    def test_threshold_cooldown_and_alert(self):
        plan = self.make_plan()
        health = HealthState()
        bad = {"dongle0": {"State": "Not connected", "IMSI": ""}}
        policy = WatchdogPolicy(threshold_seconds=120, cooldown_seconds=600,
                                max_resets=1, reset_window_seconds=3600)
        self.assertEqual(evaluate(plan, bad, health, 1000, policy), [])
        self.assertEqual(evaluate(plan, bad, health, 1100, policy), [])
        actions = evaluate(plan, bad, health, 1121, policy)
        self.assertEqual([a.action for a in actions], ["reset"])
        self.assertEqual(evaluate(plan, bad, health, 1200, policy), [])
        alert = evaluate(plan, bad, health, 2000, policy)
        self.assertEqual([a.action for a in alert], ["alert"])

    def test_healthy_clears_state(self):
        plan = self.make_plan()
        health = HealthState()
        bad = {"dongle0": {"State": "Not connected", "IMSI": ""}}
        good = {"dongle0": {"State": "Free", "IMSI": "420034224069179"}}
        evaluate(plan, bad, health, 1000, WatchdogPolicy())
        self.assertIn("dongle0", health.dongles)
        evaluate(plan, good, health, 1010, WatchdogPolicy())
        self.assertNotIn("dongle0", health.dongles)


if __name__ == "__main__":
    unittest.main()
