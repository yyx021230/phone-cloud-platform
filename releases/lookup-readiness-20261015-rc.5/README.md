# Preserve original failure when evidence is unavailable

One Python file over rc.4. The command-line failure handler previously queried focus without guarding that read. A disconnected phone could therefore raise again and prevent the structured original error from being returned. Preserve the original traceback/error, mark missing focus evidence, return a failed result, and do not repeat execution or fabricate empty name.

Old two tests had one error; new two, full Python 365 and native Windows two pass. No further changes to worker/control/lifecycle; rc.4 Node 741 evidence retained. Deployment only after idle target check and backup, preserve ACL and all rc.4 files. No shared restart, no data restore. Rollback this file to rc.4; other overlay files stay.
