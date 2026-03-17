// =======================
// FORM SUBMISSION
// =======================
const form = document.getElementById("studentForm");

if (form) {
  form.addEventListener("submit", async function (e) {
    e.preventDefault();

    const first  = document.getElementById("firstName");
    const middle = document.getElementById("middleName");
    const last   = document.getElementById("lastName");
    const index  = document.getElementById("indexNumber");
    const region = document.getElementById("region");

    // Clear previous errors
    document.getElementById("firstNameError").textContent = "";
    document.getElementById("lastNameError").textContent  = "";
    document.getElementById("indexError").textContent     = "";

    // VALIDATION
    let valid = true;

    if (first.value.trim() === "") {
      document.getElementById("firstNameError").textContent = "First name is required";
      valid = false;
    }

    if (last.value.trim() === "") {
      document.getElementById("lastNameError").textContent = "Last name is required";
      valid = false;
    }

    if (index.value.trim() === "") {
      document.getElementById("indexError").textContent = "Index number is required";
      valid = false;
    } else if (index.value.includes(" ")) {
      document.getElementById("indexError").textContent = "Index number cannot contain spaces";
      valid = false;
    }

    if (!valid) return;

    // Disable button to prevent double submit
    const submitBtn = form.querySelector("button[type='submit']");
    submitBtn.disabled = true;
    submitBtn.textContent = "Submitting...";

    const student = {
      first:  first.value.trim(),
      middle: middle.value.trim(),
      last:   last.value.trim(),
      index:  index.value.trim(),
      region: region.value,
      joinedAt: new Date().toISOString(),
    };

    // CHECK DUPLICATE first, then assign group with fresh data
    try {
      const dupSnapshot = await db.collection("students")
        .where("index", "==", student.index)
        .get();

      if (!dupSnapshot.empty) {
        document.getElementById("indexError").textContent =
          "This index number has already been used.";
        submitBtn.disabled = false;
        submitBtn.textContent = "Join Group";
        return;
      }

      await assignGroup(student);

    } catch (err) {
      console.error("Error submitting:", err);
      submitBtn.disabled = false;
      submitBtn.textContent = "Join Group";
      return;
    }

    submitBtn.disabled = false;
    submitBtn.textContent = "Join Group";
  });
}

// =======================
// GROUP ASSIGNMENT
// Uses Firestore transaction so reads + writes are atomic
// Nothing gets half-saved — either everything succeeds or nothing does
// =======================
async function assignGroup(student) {
  try {
    const groupsRef   = db.collection("groups");
    const studentsRef = db.collection("students");
    const counterRef  = db.collection("meta").doc("groupCounter");

    const assignedLabel = await db.runTransaction(async (transaction) => {

      // 1. Fetch ALL groups + counter fresh inside transaction
      const [groupsSnap, counterDoc] = await Promise.all([
        groupsRef.get(),
        counterRef.get()
      ]);

      let groups = [];
      groupsSnap.forEach((doc) => {
        groups.push({ id: doc.id, ref: doc.ref, ...doc.data() });
      });

      // Sort by groupNumber — fill earlier groups first
      groups.sort((a, b) => (a.groupNumber || 0) - (b.groupNumber || 0));

      // Get next group number from counter (never from groups.length)
      const currentCount = counterDoc.exists ? counterDoc.data().count : 0;

      let assignedGroup = null;

      // 2. Find open same-region group
      for (let group of groups) {
        const memberCount = (group.members || []).length;
        if (!group.locked && memberCount < 10 && group.region === student.region) {
          assignedGroup = group;
          break;
        }
      }

      // 3. No open same-region group → create new group using counter
      if (!assignedGroup) {
        const groupNumber = currentCount + 1;
        const newGroupRef = groupsRef.doc("Group-" + groupNumber);
        assignedGroup = {
          id: "Group-" + groupNumber,
          ref: newGroupRef,
          groupNumber: groupNumber,
          label: "Group " + groupNumber,
          region: student.region,
          members: [],
          locked: false,
        };
        // Create new group doc
        transaction.set(newGroupRef, {
          groupNumber: groupNumber,
          label: "Group " + groupNumber,
          region: student.region,
          members: [],
          locked: false,
        });
        // Increment counter
        transaction.set(counterRef, { count: groupNumber });
      }

      // 4. Add student to group
      const existingMembers = assignedGroup.members || [];
      const newMembers = [...existingMembers, student];
      const isNowFull = newMembers.length >= 10;

      transaction.update(assignedGroup.ref, {
        members: newMembers,
        locked: isNowFull,
      });

      // 5. Save student to students collection in same transaction
      const newStudentRef = studentsRef.doc();
      transaction.set(newStudentRef, {
        ...student,
        groupId: assignedGroup.id,
        groupLabel: assignedGroup.label,
      });

      return assignedGroup.label;
    });

    showSuccess(assignedLabel);

  } catch (err) {
    console.error("Error assigning group:", err);
    alert("Something went wrong. Please try again.");
  }
}

// =======================
// ORPHAN RECOVERY
// Finds students in the students collection who are not in any group
// and reassigns them automatically
// =======================
async function recoverOrphanedStudents() {
  try {
    const [studentsSnap, groupsSnap] = await Promise.all([
      db.collection("students").get(),
      db.collection("groups").get()
    ]);

    // Build a set of all index numbers currently in any group
    const indexesInGroups = new Set();
    groupsSnap.forEach((doc) => {
      const members = doc.data().members || [];
      members.forEach((m) => indexesInGroups.add(m.index));
    });

    // Find students whose index is NOT in any group
    const orphans = [];
    studentsSnap.forEach((doc) => {
      const s = doc.data();
      if (!indexesInGroups.has(s.index)) {
        orphans.push(s);
      }
    });

    if (orphans.length === 0) return;

    console.log(`Found ${orphans.length} orphaned student(s). Reassigning...`);

    // Reassign each orphan — delete from students first to avoid dup check blocking
    for (const orphan of orphans) {
      // Remove from students collection so duplicate check doesn't block them
      const existing = await db.collection("students")
        .where("index", "==", orphan.index).get();
      for (const doc of existing.docs) {
        await doc.ref.delete();
      }
      // Reassign to a group
      await assignGroup(orphan);
    }

    console.log("Orphan recovery complete.");

  } catch (err) {
    console.error("Orphan recovery error:", err);
  }
}

// =======================
// SUCCESS POPUP
// =======================
function showSuccess(groupLabel) {
  document.getElementById("groupMessage").textContent =
    "You have been placed in " + groupLabel + "! 🎉";

  // Close join modal first
  const joinModalEl = document.getElementById("joinModal");
  if (joinModalEl) {
    const joinModal = bootstrap.Modal.getInstance(joinModalEl);
    if (joinModal) joinModal.hide();
  }

  setTimeout(() => {
    const successModal = new bootstrap.Modal(document.getElementById("successModal"));
    successModal.show();

    // If on groups page, reload cards when success modal is dismissed
    const successModalEl = document.getElementById("successModal");
    successModalEl.addEventListener("hidden.bs.modal", function onHide() {
      successModalEl.removeEventListener("hidden.bs.modal", onHide);
      if (document.getElementById("groupsContainer")) loadGroups();
    });
  }, 400);
}

function goToGroups() {
  window.location.href = "groups.html";
}

// =======================
// LOAD GROUP CARDS (groups.html)
// =======================
async function loadGroups() {
  const container = document.getElementById("groupsContainer");
  if (!container) return;

  container.innerHTML = `<div class="text-center w-100 py-5 text-muted">Loading groups...</div>`;

  try {
    const groupsSnap = await db.collection("groups").get();
    const groupDocs = [];
    groupsSnap.forEach((doc) => groupDocs.push({ id: doc.id, ...doc.data(), _ref: doc }));
    groupDocs.sort((a, b) => (a.groupNumber || 0) - (b.groupNumber || 0));

    if (groupDocs.length === 0) {
      container.innerHTML = `<div class="text-center w-100 py-5 text-muted">No groups yet. Be the first to join!</div>`;
      return;
    }

    container.innerHTML = "";

    groupDocs.forEach((group) => {
      const count = group.members ? group.members.length : 0;
      const label = group.label || group.id;
      const isLocked = count >= 10;
      const fillPercent = (count / 10) * 100;
      const barColor = isLocked ? "#e63946" : count >= 7 ? "#f4a261" : "#4facfe";

      const col = document.createElement("div");
      col.className = "col-sm-6 col-md-4 col-lg-3";
      col.innerHTML = `
        <div class="groupCard card h-100">
          <div class="card-body d-flex flex-column align-items-center text-center p-4">
            <div class="group-icon mb-2">👥</div>
            <h5 class="fw-bold mb-1">${label}</h5>
            <span class="badge mb-3 ${isLocked ? "bg-danger" : "bg-primary"}">
              ${isLocked ? "Full" : "Open"}
            </span>
            <p class="mb-1 text-muted small">${count} / 10 members</p>
            <div class="progress w-100 mb-3" style="height:6px; border-radius:10px;">
              <div class="progress-bar" style="width:${fillPercent}%; background:${barColor}; border-radius:10px;"></div>
            </div>
            <button class="btn btn-sm btn-outline-primary mt-auto w-100"
              onclick="viewGroup('${group.id}', '${label}')">
              View Members
            </button>
          </div>
        </div>
      `;
      container.appendChild(col);
    });

  } catch (err) {
    console.error("Error loading groups:", err);
    container.innerHTML = `<div class="text-center text-danger w-100">Failed to load groups. Please refresh.</div>`;
  }
}

loadGroups();

// Auto-recover any students who lost their group due to past overwrites
recoverOrphanedStudents();
// =======================
async function viewGroup(groupId, groupLabel) {
  try {
    const doc = await db.collection("groups").doc(groupId).get();
    const group = doc.data();
    const members = group.members || [];

    // Set modal title
    document.getElementById("modalGroupTitle").textContent = groupLabel || groupId;
    document.getElementById("modalMemberCount").textContent = members.length + " / 10 members";

    const list = document.getElementById("memberList");
    list.innerHTML = "";

    if (members.length === 0) {
      list.innerHTML = `<li class="list-group-item text-muted text-center">No members yet</li>`;
    } else {
      members.forEach((m, i) => {
        const li = document.createElement("li");
        li.className = "list-group-item d-flex align-items-center gap-3 py-3";
        li.innerHTML = `
          <div class="member-avatar">${m.first.charAt(0)}${m.last.charAt(0)}</div>
          <div class="flex-grow-1">
            <div class="fw-semibold">${m.first} ${m.middle ? m.middle + " " : ""}${m.last}</div>
            <div class="text-muted small">${m.index} &nbsp;•&nbsp; ${m.region}</div>
          </div>
          <span class="badge bg-light text-secondary border">#${i + 1}</span>
        `;
        list.appendChild(li);
      });
    }

    const modal = new bootstrap.Modal(document.getElementById("groupModal"));
    modal.show();

  } catch (err) {
    console.error("Error viewing group:", err);
  }
}

// =======================
// SEARCH BY NAME (partial match)
// =======================
async function searchStudent() {
  const query  = document.getElementById("searchIndex").value.trim().toLowerCase();
  const result = document.getElementById("searchResult");

  if (!query) {
    result.innerHTML = "Please enter a name to search.";
    result.className = "text-warning fw-bold";
    return;
  }

  result.innerHTML = "Searching...";
  result.className = "text-muted fw-bold";

  try {
    const groupsSnap = await db.collection("groups").get();
    const matches = [];

    groupsSnap.forEach((doc) => {
      const group = doc.data();
      const label = group.label || doc.id;
      const members = group.members || [];

      members.forEach((m) => {
        const fullName = `${m.first} ${m.middle ? m.middle + " " : ""}${m.last}`.toLowerCase();
        if (fullName.includes(query)) {
          matches.push({ m, label });
        }
      });
    });

    if (matches.length === 0) {
      result.innerHTML = `No student found matching "<strong>${query}</strong>".`;
      result.className = "text-danger fw-bold";
      return;
    }

    // Build result lines for all matches
    result.className = "text-success fw-bold";
    result.innerHTML = matches.map(({ m, label }) => {
      const fullName = `${m.first} ${m.middle ? m.middle + " " : ""}${m.last}`;
      return `${fullName} (${m.index}) — ${label}`;
    }).join("<br>");

  } catch (err) {
    console.error("Error searching:", err);
    result.textContent = "Search failed. Please try again.";
    result.className = "text-danger fw-bold";
  }
}
