import { Component, input } from '@angular/core';
import type { PlannerProgress } from '@shared/index';

@Component({
  selector: 'app-planner-tasks',
  standalone: true,
  templateUrl: './planner-tasks.html',
  styleUrl: './planner-tasks.css',
})
export class PlannerTasksComponent {
  readonly planner = input.required<PlannerProgress>();
}
